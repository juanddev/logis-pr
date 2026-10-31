import { graphTokenPath, type Config } from '../config/index.js';
import type { TeamsMessage } from '../message/index.js';
import type { FetchLike } from '../utils/http.js';
import { getGraphToken, sendViaGraph, type GraphDeps } from './graph.js';
import { sendViaWorkflow, type TeamsPayload } from './workflow.js';

export type { TeamsPayload } from './workflow.js';

export interface TeamsContext {
  ticket: string;
  desc: string;
  prUrl: string;
  ticketUrl: string;
}

export function buildPayload(message: TeamsMessage, ctx: TeamsContext): TeamsPayload {
  return { text: message.text, html: message.html, ...ctx, source: 'logis-pr' };
}

/** Fungsi pengirim yang dipakai orkestrator (bisa di-mock di test). */
export type TeamsSender = (payload: TeamsPayload) => Promise<void>;

export function createTeamsSender(
  config: Config,
  deps: { fetchImpl?: FetchLike; interactive: boolean; graph?: GraphDeps; homeDir?: string },
): TeamsSender {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (config.teamsMode === 'graph') {
    return async (payload) => {
      const token = await getGraphToken(
        {
          tenantId: config.graphTenantId,
          clientId: config.graphClientId,
          cachePath: graphTokenPath({ homeDir: deps.homeDir }),
        },
        { interactive: deps.interactive },
        { fetchImpl, ...deps.graph },
      );
      await sendViaGraph(token, config.graphChatId, payload.html, fetchImpl);
    };
  }
  return (payload) => sendViaWorkflow(config.teamsWebhookUrl, payload, fetchImpl);
}
