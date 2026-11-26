'use strict';
const { fixture } = require('./helpers');
const { workflowTests } = require('./workflows');
workflowTests('Payment API behavior with an isolated in-memory repository and mocked provider', async () => fixture());
