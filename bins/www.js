#!/usr/bin/env node

/**
 * Module dependencies.
 */

const { ENV_PATH } = require('../src/configs/path');

require('dotenv').config({ path: ENV_PATH });
require('./database');
require('./http');
require('./cron');
