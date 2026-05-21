import {createNativeRuntimeClient} from './nativeClient.js';
import type {RuntimeClient, RuntimeClientOptions, RuntimeEventHandler} from './protocol.js';

export type {ApprovalRequest, RuntimeClient, RuntimeClientOptions, RuntimeEvent, RuntimeEventHandler, RuntimeRequest} from './protocol.js';

export function createRuntimeClient(emit: RuntimeEventHandler, options: RuntimeClientOptions = {}): RuntimeClient {
	if (process.env.OPENMELON_RUNTIME === 'process' || process.env.OPENMELON_RUNTIME === 'go') {
		emit({type: 'append', kind: 'error', text: 'Go process runtime is retired in the TS-only entrypoint; using native TypeScript runtime.'});
	}
	return createNativeRuntimeClient(emit, options);
}
