'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const project = path.join(__dirname, '..');
const destination = path.join(project, '.env');
if (!fs.existsSync(destination)) fs.copyFileSync(path.join(project, '.env.example'), destination);
let contents = fs.readFileSync(destination, 'utf8');
if (/^APP_API_KEY=\s*$/m.test(contents)) {
  contents = contents.replace(/^APP_API_KEY=\s*$/m, 'APP_API_KEY=' + randomBytes(32).toString('hex'));
  fs.writeFileSync(destination, contents, { mode: 0o600 });
}
fs.chmodSync(destination, 0o600);
console.info('Created/preserved .env. APP_API_KEY is stored there; existing credentials were preserved.');
console.info('Next: fill in database and Selcom credentials, create your database, run npm run migrate, then npm start.');
