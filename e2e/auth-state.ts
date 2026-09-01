import path from 'node:path'

// Where the suite's one signed-in session is saved. Lives apart from
// auth.setup.ts because the Playwright config imports this, and a config
// may not import a file that calls test().
export const STATE_PATH = path.join(new URL('.', import.meta.url).pathname, '.auth', 'state.json')
