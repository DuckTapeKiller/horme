/**
 * A stand-in for the "obsidian" module in unit tests: requestUrl answers from
 * whatever the test puts in `requests.respond`, and records every call.
 */
export interface RecordedRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export const requests: {
  sent: RecordedRequest[];
  respond: (req: RecordedRequest) => { status: number; json?: unknown; text?: string };
} = {
  sent: [],
  respond: () => ({ status: 200, json: {} }),
};

export function requestUrl(req: RecordedRequest): Promise<{ status: number; json: unknown; text: string }> {
  requests.sent.push(req);
  const r = requests.respond(req);
  return Promise.resolve({
    status: r.status,
    json: r.json ?? {},
    text: r.text ?? JSON.stringify(r.json ?? {}),
  });
}

export class Notice {
  constructor(public message: string) {}
}

export const Platform = { isMobile: false, isDesktop: true };
