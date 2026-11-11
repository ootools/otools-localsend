import { invoke, listenTauri } from './runtime';
import { createCaptureApi } from './capture-factory';
export * from './capture-factory';
export const capture = createCaptureApi({ invoke, listen: listenTauri });
