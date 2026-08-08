// Module catalog. Each module is a self-contained definition; the engine
// and admin UI consume this map — adding a module means adding an entry.
import calendarModule from './calendar/index.js';
import boosterModule from './booster.js';

export const MODULES = {
  [calendarModule.key]: calendarModule,
  [boosterModule.key]: boosterModule,
};

export function _setModuleForTest(key, def) { MODULES[key] = def; }
