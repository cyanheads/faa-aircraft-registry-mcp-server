/**
 * @fileoverview Barrel collecting all FAA registry resource definitions into the
 * `allResourceDefinitions` array consumed by `createApp()`.
 * @module mcp-server/resources/definitions/index
 */

import { registrationResource } from './registration.resource.js';

export const allResourceDefinitions = [registrationResource];
