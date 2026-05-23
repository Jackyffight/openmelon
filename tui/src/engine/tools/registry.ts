// Runtime tool registry, ported from internal/tools.
//
// A tool is one callable function the model can invoke. Each has a JSON-schema
// parameter spec and returns a JSON-serializable value. The runtime asks the
// registry for the specs to advertise and dispatches calls back to handlers.

import type {ToolRegistry, ToolSpec} from '../runtime.js';

export type {ToolSpec} from '../runtime.js';

/** A tool handler receives the parsed argument object and returns a JSON-serializable value (or throws). */
export type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> | unknown;

export type ToolDef = {
	spec: ToolSpec;
	handler: ToolHandler;
};

export class Registry implements ToolRegistry {
	private readonly tools = new Map<string, ToolDef>();
	private readonly order: string[] = [];

	/** Add a tool. Throws on duplicate names so nobody silently shadows a tool. */
	register(tool: ToolDef): void {
		if (this.tools.has(tool.spec.name)) {
			throw new Error(`tools: duplicate registration: ${tool.spec.name}`);
		}
		this.tools.set(tool.spec.name, tool);
		this.order.push(tool.spec.name);
	}

	specs(): ToolSpec[] {
		return this.order.map(name => this.tools.get(name)!.spec);
	}

	names(): string[] {
		return [...this.order];
	}

	async dispatch(name: string, argsJson: string, signal?: AbortSignal): Promise<unknown> {
		const tool = this.tools.get(name);
		if (!tool) {
			throw new Error(`unknown tool: ${JSON.stringify(name)} (available: ${this.names().join(', ')})`);
		}
		let args: Record<string, unknown>;
		try {
			const parsed = argsJson.trim() ? JSON.parse(argsJson) : {};
			args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
		} catch (error) {
			throw new Error(`invalid tool arguments: ${(error as Error).message}`);
		}
		return tool.handler(args, signal);
	}
}
