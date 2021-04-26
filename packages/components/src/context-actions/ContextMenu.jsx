import React, { PureComponent } from 'react';
import classNames from 'classnames';
import PropTypes from 'prop-types';
import Log from '@deephaven/log';
import { PromiseUtils } from '@deephaven/utils';
import ContextActionUtils from './ContextActionUtils';
import ContextMenuItem from './ContextMenuItem';
import LoadingSpinner from '../LoadingSpinner';

const log = Log.module('ContextMenu');

/** Do not use this class directly. Use ContextMenuRoot and ContextActions instead. */
class ContextMenu extends PureComponent {
  static handleContextMenu(e) {
    if (e.metaKey) {
      return;
    }

    e.stopPropagation();
    e.preventDefault();
  }

  constructor(props) {
    super(props);

    this.handleBlur = this.handleBlur.bind(this);
    this.handleCloseSubMenu = this.handleCloseSubMenu.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleMenuItemClick = this.handleMenuItemClick.bind(this);
    this.handleMenuItemContextMenu = this.handleMenuItemContextMenu.bind(this);
    this.handleMenuItemMouseMove = this.handleMenuItemMouseMove.bind(this);
    this.handleMouseLeave = this.handleMouseLeave.bind(this);
    this.handleWindowResize = this.handleWindowResize.bind(this);

    this.container = null;
    this.oldFocus = document.activeElement;
    this.activeSubMenuRef = React.createRef();
    this.subMenuTimer = null;
    this.rAF = null;

    this.state = {
      menuItems: [],
      pendingItems: [],
      activeSubMenu: null,
      hasOverflow: false,
      subMenuTop: 0,
      subMenuLeft: 0,
      subMenuParentWidth: null,
      subMenuParentHeight: null,
      keyboardIndex: -1,
      mouseIndex: -1,
    };
  }

  componentDidMount() {
    this.initMenu();

    this.verifyPosition();

    window.addEventListener('resize', this.handleWindowResize);

    // rAF is needed to wait for a submenus popper to be created before
    // attempting to set focus, however on a quick mount/unmount when
    // mousing past an item, the submenu could be unmounted before the
    // async rAF finishes, so it is cancelled in willUnmount()
    this.rAF = window.requestAnimationFrame(() => {
      this.container.focus();

      const { onMenuOpened } = this.props;
      onMenuOpened(this);
    });
  }

  componentDidUpdate(prevProps, prevState) {
    const { actions } = this.props;
    const { activeSubMenu } = this.state;

    if (prevProps.actions !== actions) {
      this.initMenu();
      if (!this.container.contains(document.activeElement)) {
        this.container.focus();
      }
    }

    if (activeSubMenu !== prevState.activeSubMenu) {
      this.setActiveSubMenuPosition();
    }

    if (prevState.activeSubMenu !== activeSubMenu) {
      this.container.focus();
    }

    this.verifyPosition();
  }

  componentWillUnmount() {
    this.cancelPromises();
    window.removeEventListener('resize', this.handleWindowResize);
    cancelAnimationFrame(this.rAF);
  }

  getKeyboardIndex() {
    const { options } = this.props;
    if (options.separateKeyboardMouse) {
      const { keyboardIndex } = this.state;
      return keyboardIndex;
    }

    return this.getMouseIndex();
  }

  setKeyboardIndex(index) {
    const { options } = this.props;
    if (options.separateKeyboardMouse) {
      this.setState({ keyboardIndex: index });
    } else {
      this.setMouseIndex(index);
    }
  }

  getMouseIndex() {
    const { mouseIndex } = this.state;
    return mouseIndex;
  }

  setMouseIndex(index) {
    this.setState({ mouseIndex: index });
  }

  initMenu() {
    // cancel any pending close and promises
    this.cancelPromises();
    cancelAnimationFrame(this.rAF);

    const { options } = this.props;
    let keyboardIndex = options.initialKeyboardIndex;
    if (!Number.isInteger(keyboardIndex)) {
      keyboardIndex = -1;
    }

    this.setState({
      mouseIndex: -1,
      keyboardIndex,
      menuItems: [],
      pendingItems: [],
      activeSubMenu: null,
    });

    const { actions } = this.props;
    const menuItems = ContextActionUtils.getMenuItems(actions);
    for (let i = menuItems.length - 1; i >= 0; i -= 1) {
      const menuItem = menuItems[i];
      if (menuItem.then && typeof menuItem.then === 'function') {
        this.initMenuPromise(menuItem);
        menuItems.splice(i, 1);
      }
    }

    this.setState(state => {
      const newState = {};

      if (menuItems.length > 0) {
        newState.menuItems = ContextActionUtils.sortActions(
          state.menuItems.concat(menuItems)
        );
      }

      return newState;
    });
  }

  initMenuPromise(promise) {
    // make all promises cancellable
    const cancellablePromise = PromiseUtils.makeCancelable(promise);

    this.setState(state => ({
      pendingItems: state.pendingItems.concat(cancellablePromise),
    }));

    cancellablePromise.then(
      resolvedMenuItems => {
        this.setState(state => {
          const index = state.pendingItems.indexOf(cancellablePromise);
          if (index >= 0) {
            const pendingItems = state.pendingItems.slice();
            pendingItems.splice(index, 1);

            return {
              menuItems: ContextActionUtils.sortActions(
                state.menuItems.concat(resolvedMenuItems)
              ),
              pendingItems,
            };
          }
          // This item is stale, don't update the menu
          return null;
        });
      },
      error => {
        if (PromiseUtils.isCanceled(error)) {
          return; // Canceled promise is ignored
        }

        // remove failed item from pending list
        this.setState(state => {
          const index = state.pendingItems.indexOf(cancellablePromise);
          if (index >= 0) {
            const pendingItems = state.pendingItems.slice();
            pendingItems.splice(index, 1);
            return {
              pendingItems,
            };
          }
          return null;
        });

        // Log the error
        log.error(error);
      }
    );
  }

  cancelPromises() {
    const { pendingItems } = this.state;
    pendingItems.map(item => item.cancel());
  }

  /**
   * Sets the unverfied start position of a submenu. Submenu then self-verfies
   * its own position and potentially reports back a new position.
   */
  setActiveSubMenuPosition() {
    if (this.activeSubMenuRef.current === null) return;
    const parentRect = this.activeSubMenuRef.current.getBoundingClientRect();

    // intentionally rect.right, we want the sub menu to start at the right edge of the current menu
    this.setState({
      subMenuTop: parentRect.top,
      subMenuLeft: parentRect.right,
      subMenuParentHeight: parentRect.height,
      subMenuParentWidth: parentRect.width,
    });
  }

  /**
   * Verifies the position of this menu in relation to the parent to make sure it's on screen.
   * Will update the top left state (updatePosition) if necessary (causing a re-render)
   * By default it tries to top-align with parent, at the right side of the parent.
   * Because we aren't a native context menu and can't escape window bounds, we also do
   * somethings to better fit on screen, such as the "nudge" offset position, and further
   * allow overflow scrolling for large menus in a small window.
   */
  verifyPosition() {
    const {
      options,
      updatePosition,
      subMenuParentWidth,
      subMenuParentHeight,
      left: oldLeft,
      top: oldTop,
    } = this.props;

    if (!this.container || options.doNotVerifyPosition) {
      return;
    }

    let { top, left } = this.container.getBoundingClientRect();
    const { width, height } = this.container.getBoundingClientRect();
    const hasOverflow = this.container.scrollHeight > window.innerHeight;

    if (height === 0 && width === 0) {
      // We don't have a height or width yet, don't bother doing anything
      return;
    }

    // does it fit below?
    if (top + height > window.innerHeight) {
      // can it be flipped to above? include offset if submenu (defaults to 0 if not submenu)
      if (top - height - subMenuParentHeight > 0) {
        // flip like a native menu would
        top -= height - subMenuParentHeight;
      } else {
        // still doesnt fit? okay, position at bottom edge
        top = window.innerHeight - height;
      }
    }

    if (left + width > window.innerWidth) {
      // less picky about left right positioning, just keep it going off to right
      left = left - width - subMenuParentWidth;
    }

    if (oldLeft !== left || oldTop !== top) {
      // parent owns positioning as single source of truth, ask to update props
      this.setState({ hasOverflow });
      updatePosition(top, left);
    }
  }

  // since window resize doesn't trigger blur, listen and close the menu
  handleWindowResize() {
    if (!this.container) {
      return;
    }
    this.closeMenu(true);
  }

  handleBlur(e) {
    if (!this.container) {
      log.warn('Container is null!');
      return;
    }

    if (!this.container.contains(e.relatedTarget)) {
      let element = e.relatedTarget;
      let isContextMenuChild = false;
      while (element && element.nodeType === 1 && !isContextMenuChild) {
        isContextMenuChild = element.hasAttribute('data-dh-context-menu');
        element = element.parentNode;
      }

      if (!isContextMenuChild) {
        // close all submenus on blur
        this.closeMenu(true);
      }
    }
  }

  /** Returns whether the specified key should remove the menu. Depends on the side the parent is on. */
  isEscapeKey(key) {
    const { left } = this.state;
    return (
      key === 'Escape' ||
      (left < 0 && key === 'ArrowRight') ||
      key === 'ArrowLeft'
    );
  }

  handleKeyDown(e) {
    const { menuItems } = this.state;
    const oldFocus = this.getKeyboardIndex();
    let newFocus = oldFocus;
    let openSubMenu = false;

    if (e.key === 'Enter' || e.key === ' ') {
      if (oldFocus >= 0 && oldFocus < menuItems.length) {
        this.handleMenuItemClick(menuItems[oldFocus], e);
      }
      return;
    }

    if (e.key === 'ArrowRight') {
      if (oldFocus >= 0 && oldFocus <= menuItems.length) {
        openSubMenu = true;
      } else {
        newFocus = 0;
      }
    } else if (this.isEscapeKey(e.key)) {
      newFocus = null;
    } else if (e.key === 'ArrowUp') {
      newFocus = ContextActionUtils.getNextMenuItem(newFocus, -1, menuItems);
    } else if (e.key === 'ArrowDown') {
      newFocus = ContextActionUtils.getNextMenuItem(newFocus, 1, menuItems);
    }

    if (openSubMenu) {
      this.openSubMenu(oldFocus);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (oldFocus !== newFocus) {
      if (newFocus !== null) {
        this.setKeyboardIndex(newFocus);
      } else {
        this.closeMenu();
        if (this.oldFocus && this.oldFocus.focus) {
          this.oldFocus.focus();
        }
      }

      e.preventDefault();
      e.stopPropagation();
    }
  }

  openSubMenu(index) {
    const { menuItems } = this.state;
    this.setState({
      activeSubMenu: menuItems[index].actions ? index : null,
    });
  }

  closeMenu(closeAll) {
    const { closeMenu, onMenuClosed } = this.props;
    cancelAnimationFrame(this.rAF);
    this.rAF = window.requestAnimationFrame(() => {
      closeMenu(closeAll);
      onMenuClosed(this);
    });
  }

  closeSubMenu() {
    this.setState({ activeSubMenu: null });
  }

  handleCloseSubMenu(closeAllMenus) {
    if (closeAllMenus) {
      this.closeMenu(true);
    } else {
      this.closeSubMenu();
    }
  }

  handleMenuItemClick(menuItem, e) {
    e.preventDefault();
    e.stopPropagation();

    const { menuItems } = this.state;
    if (menuItem != null && !menuItem.disabled) {
      if (menuItem.actions != null) {
        this.openSubMenu(menuItems.indexOf(menuItem));
      } else if (menuItem.action != null) {
        menuItem.action();
        this.closeMenu(true);
      }
    }
  }

  handleMenuItemContextMenu(menuItem, e) {
    if (e.metaKey) {
      return;
    }

    this.handleMenuItemClick(menuItem, e);
  }

  handleMenuItemMouseMove(menuItem) {
    const { menuItems } = this.state;
    const focusIndex = menuItems.indexOf(menuItem);
    this.setMouseIndex(focusIndex);

    if (
      focusIndex >= 0 &&
      focusIndex < menuItems.length &&
      !menuItem.disabled
    ) {
      this.openSubMenu(focusIndex);
    }
  }

  handleMouseLeave() {
    this.setMouseIndex(-1);
  }

  render() {
    const menuItemElements = [];
    const { top, left } = this.props;
    const {
      activeSubMenu,
      hasOverflow,
      keyboardIndex,
      menuItems,
      mouseIndex,
      pendingItems,
      subMenuTop,
      subMenuLeft,
      subMenuParentWidth,
      subMenuParentHeight,
    } = this.state;
    for (let i = 0; i < menuItems.length; i += 1) {
      const menuItem = menuItems[i];

      if (i > 0 && menuItem.group !== menuItems[i - 1].group) {
        menuItemElements.push(<hr key={`${i}.separator`} />);
      }

      const menuItemElement = (
        <ContextMenuItem
          key={i}
          ref={activeSubMenu === i ? this.activeSubMenuRef : null}
          isKeyboardSelected={keyboardIndex === i}
          isMouseSelected={mouseIndex === i}
          menuItem={menuItem}
          closeMenu={this.handleCloseSubMenu}
          onMenuItemClick={this.handleMenuItemClick}
          onMenuItemMouseMove={this.handleMenuItemMouseMove}
          onMenuItemContextMenu={this.handleMenuItemContextMenu}
        />
      );

      menuItemElements.push(menuItemElement);
    }

    let pendingElement = null;
    if (pendingItems.length > 0) {
      pendingElement = (
        <div className="loading">
          <LoadingSpinner />
        </div>
      );
    }

    const { menuStyle } = this.props;

    return (
      <>
        <div
          className={classNames(
            { 'has-overflow': hasOverflow },
            'context-menu-container'
          )}
          style={{ top, left, ...menuStyle }}
          ref={container => {
            this.container = container;
          }}
          data-dh-context-menu
          onBlur={this.handleBlur}
          onKeyDown={this.handleKeyDown}
          onMouseLeave={this.handleMouseLeave}
          onContextMenu={ContextMenu.handleContextMenu}
          role="menuitem"
          tabIndex="0"
        >
          {menuItemElements}
          {pendingElement}
        </div>
        {activeSubMenu !== null && (
          <ContextMenu
            key={`sub-${activeSubMenu}`}
            actions={menuItems[activeSubMenu].actions}
            closeMenu={this.handleCloseSubMenu}
            top={subMenuTop}
            left={subMenuLeft}
            updatePosition={(verifiedTop, verifiedLeft) => {
              this.setState({
                subMenuTop: verifiedTop,
                subMenuLeft: verifiedLeft,
              });
            }}
            subMenuParentWidth={subMenuParentWidth}
            subMenuParentHeight={subMenuParentHeight}
          />
        )}
      </>
    );
  }
}

ContextMenu.propTypes = {
  top: PropTypes.number.isRequired,
  left: PropTypes.number.isRequired,
  updatePosition: PropTypes.func.isRequired,

  // only submenus will have these, defaults to 0 otherwise
  // represents the width height of the parent menu item
  subMenuParentWidth: PropTypes.number,
  subMenuParentHeight: PropTypes.number,

  actions: PropTypes.oneOfType([
    PropTypes.array,
    PropTypes.func,
    PropTypes.shape({}),
  ]).isRequired,

  closeMenu: PropTypes.func,
  onMenuClosed: PropTypes.func,
  onMenuOpened: PropTypes.func,
  options: PropTypes.shape({
    doNotVerifyPosition: PropTypes.bool,
    separateKeyboardMouse: PropTypes.bool,
    initialKeyboardIndex: PropTypes.number,
  }),
  menuStyle: PropTypes.shape({}),
};

ContextMenu.defaultProps = {
  subMenuParentWidth: 0,
  subMenuParentHeight: 0,
  closeMenu: () => {},
  onMenuOpened: () => {},
  onMenuClosed: () => {},
  options: {},
  menuStyle: {},
};

export default ContextMenu;