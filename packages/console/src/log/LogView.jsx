import React, { PureComponent } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { DropdownMenu, Tooltip } from '@deephaven/components';
import { vsGear, dhTrashUndo } from '@deephaven/icons';
import { PropTypes as APIPropTypes } from '@deephaven/jsapi-shim';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import ConsoleUtils from '../common/ConsoleUtils';
import LogLevel from './LogLevel';
import './LogView.scss';
import LogLevelMenuItem from './LogLevelMenuItem';

/**
 * Log view contents. Uses a monaco editor to display/search the contents of the log.
 */
class LogView extends PureComponent {
  static DefaultLogLevels = [
    LogLevel.STDOUT,
    LogLevel.ERROR,
    LogLevel.FATAL,
    LogLevel.STDERR,
    LogLevel.WARN,
  ];

  static AllLogLevels = [
    LogLevel.INFO,
    LogLevel.STDOUT,
    LogLevel.ERROR,
    LogLevel.FATAL,
    LogLevel.STDERR,
    LogLevel.WARN,
    LogLevel.DEBUG,
    LogLevel.TRACE,
  ];

  /** ms to buffer log messages before processing them */
  static bufferTimeout = 16;

  /** Maximum number of messages to store in the log */
  static maxLogSize = 131072;

  static truncateSize = 65536;

  static getLogText(logItem) {
    const date = new Date(logItem.micros / 1000);
    const timestamp = ConsoleUtils.formatTimestamp(date);
    return `${timestamp} ${logItem.logLevel} ${logItem.message}`;
  }

  constructor(props) {
    super(props);

    this.handleClearClick = this.handleClearClick.bind(this);
    this.handleFlushTimeout = this.handleFlushTimeout.bind(this);
    this.handleLogMessage = this.handleLogMessage.bind(this);
    this.handleMenuItemClick = this.handleMenuItemClick.bind(this);
    this.handleResetClick = this.handleResetClick.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleToggleAllClick = this.handleToggleAllClick.bind(this);

    this.cancelListener = null;
    this.editor = null;
    this.editorContainer = null;
    this.logLevelMenuItems = {};
    this.flushTimer = null;

    this.bufferedMessages = [];
    this.messages = [];

    this.state = {
      shownLogLevels: {},
    };
  }

  componentDidMount() {
    this.resetLogLevels();
    this.initMonaco();
    this.startListening();

    window.addEventListener('resize', this.handleResize);
  }

  componentDidUpdate(prevProps, prevState) {
    this.updateDimensions();

    const { shownLogLevels } = this.state;
    if (prevState.shownLogLevels !== shownLogLevels) {
      this.refreshLogText();
    }

    const { session } = this.props;
    if (prevProps.session !== session) {
      this.stopListening();
      this.startListening();
      // clear logs when starting a new console
      this.clearLogs();
    }
  }

  componentWillUnmount() {
    this.stopFlushTimer();
    this.stopListening();
    this.destroyMonaco();

    window.removeEventListener('resize', this.handleResize);
  }

  getMenuActions(shownLogLevels) {
    const actions = [];

    actions.push({
      menuElement: (
        <div className="log-level-menu-title">Display Log Levels</div>
      ),
      group: 1,
      order: 10,
    });

    for (let i = 0; i < LogView.AllLogLevels.length; i += 1) {
      const logLevel = LogView.AllLogLevels[i];
      const on =
        shownLogLevels[logLevel] != null ? shownLogLevels[logLevel] : false;
      actions.push({
        title: logLevel,
        group: 1,
        order: i + 100,

        menuElement: (
          <LogLevelMenuItem
            logLevel={logLevel}
            on={on}
            onClick={this.handleMenuItemClick}
            ref={element => {
              this.logLevelMenuItems[logLevel] = element;
            }}
          />
        ),
      });
    }

    actions.push({
      group: 1,
      order: 1000,
      menuElement: (
        <div className="log-level-menu-controls">
          <button
            type="button"
            className="btn btn-link log-level-toggle-all"
            onClick={this.handleToggleAllClick}
          >
            Toggle All
          </button>
          <button
            type="button"
            className="btn btn-link"
            onClick={this.handleResetClick}
          >
            Reset
          </button>
        </div>
      ),
    });

    return actions;
  }

  resetLogLevels() {
    const shownLogLevels = {};
    for (let i = 0; i < LogView.AllLogLevels.length; i += 1) {
      const logLevel = LogView.AllLogLevels[i];
      const isEnabled = LogView.DefaultLogLevels.indexOf(logLevel) >= 0;
      shownLogLevels[logLevel] = isEnabled;
    }

    this.setState({ shownLogLevels });
  }

  startListening() {
    const { session } = this.props;
    this.cancelListener = session.onLogMessage(this.handleLogMessage);
  }

  stopListening() {
    if (this.cancelListener != null) {
      this.cancelListener();
      this.cancelListener = null;
    }
  }

  initMonaco() {
    this.editor = monaco.editor.create(this.editorContainer, {
      copyWithSyntaxHighlighting: 'false',
      fixedOverflowWidgets: true,
      folding: false,
      fontFamily: 'Fira Mono',
      glyphMargin: false,
      language: 'log',
      lineDecorationsWidth: 0,
      lineNumbers: '',
      lineNumbersMinChars: 0,
      minimap: { enabled: false },
      readOnly: true,
      renderLineHighlight: 'none',
      scrollBeyondLastLine: false,
      value: '',
      wordWrap: 'on',
    });

    // When find widget is open, escape key closes it.
    // Instead, capture it and do nothing. Same for shift-escape.
    this.editor.addCommand(monaco.KeyCode.Escape, () => {});
    this.editor.addCommand(
      // eslint-disable-next-line no-bitwise
      monaco.KeyMod.Shift | monaco.KeyCode.Escape,
      () => {}
    );

    // Restore regular escape to clear selection, when editorText has focus.
    this.editor.addCommand(
      monaco.KeyCode.Escape,
      () => {
        this.editor.setPosition(this.editor.getPosition());
      },
      'findWidgetVisible && editorTextFocus'
    );

    this.editor.addCommand(
      // eslint-disable-next-line no-bitwise
      monaco.KeyMod.Shift | monaco.KeyCode.Escape,
      () => {
        this.editor.setPosition(this.editor.getPosition());
      },
      'findWidgetVisible && editorTextFocus'
    );
  }

  destroyMonaco() {
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }
  }

  triggerFindWidget() {
    // The actions.find action can no longer be triggered when the editor is not in focus, with monaco 0.22.x.
    // As a workaround, just focus the editor before triggering the action
    // https://github.com/microsoft/monaco-editor/issues/2355
    this.editor.focus();
    this.editor.trigger('keyboard', 'actions.find');
  }

  toggleAll() {
    const { shownLogLevels } = this.state;
    let isAllEnabled = true;
    for (let i = 0; i < LogView.AllLogLevels.length; i += 1) {
      const logLevel = LogView.AllLogLevels[i];
      if (!shownLogLevels[logLevel]) {
        isAllEnabled = false;
        break;
      }
    }

    if (isAllEnabled) {
      this.setState({ shownLogLevels: {} });
    } else {
      const updatedLogLevels = {};
      for (let i = 0; i < LogView.AllLogLevels.length; i += 1) {
        const logLevel = LogView.AllLogLevels[i];
        updatedLogLevels[logLevel] = true;
      }
      this.setState({ shownLogLevels: updatedLogLevels });
    }
  }

  toggleLogLevel(logLevel) {
    const { shownLogLevels } = this.state;
    const isEnabled = shownLogLevels[logLevel];
    const updatedLogLevels = {};
    updatedLogLevels[logLevel] = !isEnabled;
    this.updateLogLevels(updatedLogLevels);
  }

  updateLogLevels(updatedLogLevels) {
    let { shownLogLevels } = this.state;
    shownLogLevels = { ...shownLogLevels, ...updatedLogLevels };
    this.setState({ shownLogLevels });
  }

  appendLogText(text) {
    if (!this.editor) {
      return;
    }

    const model = this.editor.getModel();
    let line = model.getLineCount();
    let column = model.getLineLength(line);
    const isBottomVisible = this.isBottomVisible();

    const edits = [];
    if (column > 0) {
      edits.push({
        range: {
          startLineNumber: line,
          startColumn: column + 1,
          endLineNumber: line,
          endColumn: column + 1,
        },
        text: '\n',
        forceMoveMarkers: true,
      });
      line += 1;
      column = 0;
    }

    edits.push({
      range: {
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: column,
      },
      text,
      forceMoveMarkers: true,
    });

    model.applyEdits(edits);

    if (isBottomVisible) {
      this.editor.revealLine(model.getLineCount(), 1);
    }
  }

  /**
   * Refresh the contents of the log component with the updated filter text
   */
  refreshLogText() {
    if (!this.editor) {
      return;
    }

    this.truncateLogIfNecessary();

    const { shownLogLevels } = this.state;
    const isBottomVisible = this.isBottomVisible();

    let text = '';
    for (let i = 0; i < this.messages.length; i += 1) {
      const message = this.messages[i];
      if (shownLogLevels[message.logLevel]) {
        const logText = LogView.getLogText(message);
        if (logText.length > 0) {
          text += logText;
          if (logText.charAt(logText.length - 1) !== '\n') {
            text += '\n';
          }
        }
      }
    }
    text = text.trimRight();

    this.editor.setValue(text);

    if (isBottomVisible) {
      const line = this.editor.getModel().getLineCount();
      this.editor.revealLine(line, 1);
    }

    this.stopFlushTimer();
    this.bufferedMessages = [];
  }

  truncateLogIfNecessary() {
    if (this.messages.length > LogView.maxLogSize) {
      this.messages = this.messages.splice(
        this.messages.length - LogView.truncateSize
      );
    }
  }

  scrollToBottom() {
    if (!this.editor) {
      return;
    }

    const line = this.editor.getModel().getLineCount();
    this.editor.revealLine(line, 1);
  }

  isBottomVisible() {
    if (!this.editor) {
      return true;
    }

    const model = this.editor.getModel();
    const line = model.getLineCount();

    return this.isLineVisible(line);
  }

  isLineVisible(line) {
    const visibleRanges = this.editor.getVisibleRanges();
    if (visibleRanges == null || visibleRanges.length === 0) {
      return false;
    }

    for (let i = 0; i < visibleRanges.length; i += 1) {
      const range = visibleRanges[i];
      if (range.startLineNumber <= line && line <= range.endLineNumber) {
        return true;
      }
    }

    return false;
  }

  /** Checks if the given log message is visible with the current filters */
  isLogItemVisible(message) {
    const { shownLogLevels } = this.state;
    return shownLogLevels[message.logLevel];
  }

  flush() {
    let text = '';
    for (let i = 0; i < this.bufferedMessages.length; i += 1) {
      const message = this.bufferedMessages[i];
      const logText = LogView.getLogText(message);
      text += logText;
      if (logText.charAt(logText.length - 1) !== '\n') {
        text += '\n';
      }
    }

    this.bufferedMessages = [];

    this.appendLogText(text);
  }

  queue(message) {
    this.bufferedMessages.push(message);
    if (this.bufferedMessages.length === 1) {
      this.flushTimer = setTimeout(
        this.handleFlushTimeout,
        LogView.bufferTimeout
      );
    }
  }

  stopFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  updateDimensions() {
    if (this.editor) {
      this.editor.layout();
    }
  }

  handleClearClick() {
    this.clearLogs();
  }

  clearLogs() {
    this.messages = [];
    this.refreshLogText();
  }

  handleFlushTimeout() {
    this.stopFlushTimer();
    this.flush();
  }

  handleLogMessage(message) {
    this.messages.push(message);

    if (this.editor && this.isLogItemVisible(message)) {
      this.queue(message);
    }
  }

  handleMenuItemClick(logLevel) {
    this.toggleLogLevel(logLevel);
  }

  handleResetClick() {
    this.resetLogLevels();
  }

  handleResize() {
    this.updateDimensions();
  }

  handleToggleAllClick() {
    this.toggleAll();
  }

  render() {
    const popperOptions = { placement: 'bottom-end' };
    const { shownLogLevels } = this.state;
    const actions = this.getMenuActions(shownLogLevels);
    return (
      <div className="log-pane h-100 w-100">
        <div className="log-pane-menu">
          <button
            type="button"
            className="btn btn-link btn-link-icon btn-clear-logs"
            onClick={this.handleClearClick}
          >
            <FontAwesomeIcon icon={dhTrashUndo} />
            <Tooltip>Clear log</Tooltip>
          </button>
          <button
            type="button"
            className="btn btn-link btn-link-icon btn-overflow"
          >
            <FontAwesomeIcon icon={vsGear} />
            <Tooltip>Log Settings</Tooltip>
            <DropdownMenu
              actions={actions}
              popperClassName="log-level-menu-popper"
              popperOptions={popperOptions}
            />
          </button>
        </div>
        <div
          className="log-pane-editor h-100 w-100"
          ref={editorContainer => {
            this.editorContainer = editorContainer;
          }}
        />
      </div>
    );
  }
}

LogView.propTypes = {
  session: APIPropTypes.IdeSession.isRequired,
};

export default LogView;
