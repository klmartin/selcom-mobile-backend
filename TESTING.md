# Verification and test commands

## Results for this package

Verified on 25 November 2026:

| Check | Result |
| --- | --- |
| Offline API, signing, validation and workflow tests | 25 passed, 0 failed |
| SQL integration and actual server lifecycle tests | 22 passed, 0 failed |
| SQL server used for integration | MariaDB 11.8.9, using mysql2 and InnoDB |
| Node.js used | 24.22.3 |
| Official Selcom client used | selcom-apigw-client 1.0.0 |
| Production dependency audit | 0 reported vulnerabilities at verification time |
| Clean extracted archive installation | Passed |
| Repeated setup preserves the generated application key | Passed |
| Startup without configured credentials | Fails closed before provider requests |
| JavaScript and shell syntax | Passed |

The exact MySQL 8 runtime and Windows PowerShell example were not executed in this environment. SQL integration used the MariaDB version above; real Selcom calls, provider UAT, public HTTPS/callback delivery, and production deployment were not performed.

## Offline checks

```sh
npm ci --include=dev
npm test
npm audit
```

`npm test` uses an isolated in-memory repository, a mocked provider, the installed official client's signer, and HTTP API tests. It never needs real Selcom credentials or sends real provider requests.

## SQL integration

Use a disposable database whose name ends in `_test`. The suite deletes payment, attempt, and event rows in that database before each workflow. It refuses other database names and does not load the production `.env` for its database connection.

For example, create a separate `selcom_backend_test` database and a restricted test user, then:

```sh
TEST_DB_HOST=127.0.0.1 \
TEST_DB_PORT=3306 \
TEST_DB_NAME=selcom_backend_test \
TEST_DB_USER=selcom_test_user \
TEST_DB_PASSWORD='YOUR_TEST_DATABASE_PASSWORD' \
npm run test:integration
```

PowerShell:

```powershell
$env:TEST_DB_HOST = '127.0.0.1'
$env:TEST_DB_PORT = '3306'
$env:TEST_DB_NAME = 'selcom_backend_test'
$env:TEST_DB_USER = 'selcom_test_user'
$env:TEST_DB_PASSWORD = 'YOUR_TEST_DATABASE_PASSWORD'
npm run test:integration
```

These tests run the same API workflows against the SQL repository and additionally verify migrations, stored audit redaction, expired claims, final-attempt crash handling, UTC sessions, and actual server startup/shutdown. Selcom remains mocked. The startup check disables the worker and uses reserved `.test` provider URLs.

## Scope

Automated checks do not establish that your merchant credentials, provider URL, source-IP allowlisting, HTTPS callback delivery, enabled channels, and customer authorization work in your assigned UAT/live account. Complete a provider-approved payment test and confirm its final status before relying on the deployment for customers.
