import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ContextMenuRoot, LoadingOverlay } from '@deephaven/components'; // Use the loading spinner from the Deephaven components package
import {
  IrisGrid,
  IrisGridModel,
  IrisGridModelFactory,
  TableUtils,
} from '@deephaven/iris-grid'; // iris-grid is used to display Deephaven tables
import dh from '@deephaven/jsapi-shim'; // Import the shim to use the JS API
import Log from '@deephaven/log';
import './App.scss'; // Styles for in this app

const log = Log.module('EmbedGrid.App');

export type Command = 'filter' | 'sort';

/** Input value for filter commands */
export type FilterCommandType = {
  name: string;
  value: string;
};

export type SortCommandType = {
  name: string;
  direction?: 'ASC' | 'DESC';
};

/**
 * Load an existing Deephaven table with the session provided
 * @param session The Deephaven session object
 * @param name Name of the table to load
 * @returns Deephaven table
 */
async function loadTable(session: typeof dh.Session, name: string) {
  log.info(`Fetching table ${name}...`);

  const definition = { name, type: dh.VariableType.TABLE };
  return session.getObject(definition);
}

/**
 * A functional React component that displays a Deephaven table in an IrisGrid using the @deephaven/iris-grid package.
 * It will attempt to open and display the table specified with the `name` parameter, expecting it to be present on the server.
 * E.g. http://localhost:3000/?name=myTable will attempt to open a table `myTable`
 * If no query param is provided, it will attempt to open a new session and create a basic time table and display that.
 * By default, tries to connect to the server defined in the REACT_APP_CORE_API_URL variable, which is set to http://localhost:1000/jsapi
 * See create-react-app docs for how to update these env vars: https://create-react-app.dev/docs/adding-custom-environment-variables/
 */
function App(): JSX.Element {
  const [model, setModel] = useState<IrisGridModel>();
  const [error, setError] = useState<string>();
  const [inputFilters, setInputFilters] = useState<unknown[]>();
  const [sorts, setSorts] = useState<unknown[]>();
  const [isLoading, setIsLoading] = useState(true);
  const searchParams = useMemo(
    () => new URLSearchParams(window.location.search),
    []
  );
  const canCopy = searchParams.get('canCopy') != null;
  const canDownloadCsv = searchParams.get('canDownloadCsv') != null;

  const initApp = useCallback(async () => {
    try {
      // Connect to the Web API server
      const baseUrl = new URL(
        process.env.REACT_APP_CORE_API_URL ?? '',
        `${window.location}`
      );

      const websocketUrl = `${baseUrl.protocol}//${baseUrl.host}`;

      log.debug(`Starting connection...`);
      const connection = new dh.IdeConnection(websocketUrl);

      // Start a code session. For this example, we use python.
      log.debug(`Starting session...`);
      const session = await connection.startSession('python');

      // Get the table name from the query param `name`.
      const name = searchParams.get('name');

      if (!name) {
        throw new Error('No name param provided');
      }

      log.debug('Loading table', name, '...');

      // Load the table up.
      const table = await loadTable(session, name);

      // Create the `IrisGridModel` for use with the `IrisGrid` component
      log.debug(`Creating model...`);

      const newModel = await IrisGridModelFactory.makeModel(table);

      setModel(newModel);

      log.debug('Table successfully loaded!');
    } catch (e: unknown) {
      log.error('Unable to load table', e);
      setError(`${e}`);
    }
    setIsLoading(false);
  }, [searchParams]);

  useEffect(() => {
    initApp();
  }, [initApp]);

  useEffect(() => {
    function receiveMessage(e: MessageEvent) {
      const { command, value } = e.data as { command: Command; value: unknown };
      switch (command) {
        case 'filter': {
          const filterCommandValues = value as FilterCommandType[];
          const newInputFilters = filterCommandValues.map(
            ({ name, value: filterValue }) => {
              const column = model?.columns.find(c => c.name === name);
              if (column == null) {
                throw new Error(`Could not find column named ${name}`);
              }
              return {
                name,
                value: filterValue,
                type: TableUtils.getNormalizedType(column.type),
              };
            }
          );
          setInputFilters(newInputFilters);
          break;
        }
        case 'sort': {
          const sortCommandValues = value as SortCommandType[];
          const newSorts = sortCommandValues.map(({ name, direction }) => {
            const column = model?.columns.find(c => c.name === name);
            if (column == null) {
              throw new Error(`Could not find column named ${name}`);
            }
            return direction === 'DESC'
              ? column.sort().desc()
              : column.sort().asc();
          });
          setSorts(newSorts);
          break;
        }
      }
    }
    window.addEventListener('message', receiveMessage);

    return () => {
      window.removeEventListener('message', receiveMessage);
    };
  }, [model]);

  const isLoaded = model != null;

  return (
    <div className="App">
      {isLoaded && (
        <IrisGrid
          canCopy={canCopy}
          canDownloadCsv={canDownloadCsv}
          model={model}
          inputFilters={inputFilters}
          sorts={sorts}
        />
      )}
      {!isLoaded && (
        <LoadingOverlay
          isLoaded={isLoaded}
          isLoading={isLoading}
          errorMessage={error ?? null}
        />
      )}
      <ContextMenuRoot />
    </div>
  );
}

export default App;
