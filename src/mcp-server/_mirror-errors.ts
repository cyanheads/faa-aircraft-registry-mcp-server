/**
 * @fileoverview Readiness errors shared by FAA registry tools and resources.
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/** A refresh is in progress or needs to be completed by the operator. */
export const mirrorLoadingError = {
  reason: 'mirror_loading',
  thrownBy: 'service',
  code: JsonRpcErrorCode.ServiceUnavailable,
  when: 'The FAA registry mirror has a refresh that has not completed.',
  retryable: true,
  recovery:
    'Retry after the refresh completes. If a refresh was interrupted, have the operator run mirror:refresh.',
} as const;
