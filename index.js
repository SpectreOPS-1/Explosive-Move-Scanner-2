import { createDemoProvider } from './demo.js';
import { createApiProvider } from './api.js';

/** A Worker URL plus access code means live data; otherwise the clearly-labelled demo data. */
export function createProvider({ apiUrl, accessCode }) {
  return apiUrl && apiUrl.trim() && accessCode && accessCode.trim()
    ? createApiProvider({ baseUrl: apiUrl, accessCode: accessCode.trim() })
    : createDemoProvider();
}
