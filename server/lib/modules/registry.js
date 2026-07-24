// Module catalog. Each module is a self-contained definition; the engine
// and admin UI consume this map — adding a module means adding an entry.
import calendarModule from './calendar/index.js';

export const MODULES = {
  [calendarModule.key]: calendarModule,
};

export function _setModuleForTest(key, def) { MODULES[key] = def; }
