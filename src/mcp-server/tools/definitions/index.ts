/**
 * @fileoverview Barrel collecting all FAA registry tool definitions into the
 * `allToolDefinitions` array consumed by `createApp()`.
 * @module mcp-server/tools/definitions/index
 */

import { getAircraftTypeTool } from './get-aircraft-type.tool.js';
import { getRegistrationStatusTool } from './get-registration-status.tool.js';
import { lookupRegistrationTool } from './lookup-registration.tool.js';
import { searchAircraftTypesTool } from './search-aircraft-types.tool.js';
import { searchRegistrationsTool } from './search-registrations.tool.js';

export const allToolDefinitions = [
  lookupRegistrationTool,
  getAircraftTypeTool,
  searchRegistrationsTool,
  searchAircraftTypesTool,
  getRegistrationStatusTool,
];
