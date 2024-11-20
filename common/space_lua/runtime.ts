import type { ASTCtx, LuaFunctionBody } from "./ast.ts";
import { evalStatement } from "$common/space_lua/eval.ts";
import { asyncQuickSort } from "$common/space_lua/util.ts";

export type LuaType =
  | "nil"
  | "boolean"
  | "number"
  | "string"
  | "table"
  | "function"
  | "userdata"
  | "thread";

// These types are for documentation only
export type LuaValue = any;
export type JSValue = any;

export interface ILuaFunction {
  call(sf: LuaStackFrame, ...args: LuaValue[]): Promise<LuaValue> | LuaValue;
  toString(): string;
}

export interface ILuaSettable {
  set(key: LuaValue, value: LuaValue, sf?: LuaStackFrame): void;
}

export interface ILuaGettable {
  get(key: LuaValue, sf?: LuaStackFrame): LuaValue | undefined;
}

export class LuaEnv implements ILuaSettable, ILuaGettable {
  variables = new Map<string, LuaValue>();

  constructor(readonly parent?: LuaEnv) {
  }

  setLocal(name: string, value: LuaValue) {
    this.variables.set(name, value);
  }

  set(key: string, value: LuaValue, sf?: LuaStackFrame): void {
    if (this.variables.has(key) || !this.parent) {
      this.variables.set(key, value);
    } else {
      this.parent.set(key, value, sf);
    }
  }

  has(key: string): boolean {
    if (this.variables.has(key)) {
      return true;
    }
    if (this.parent) {
      return this.parent.has(key);
    }
    return false;
  }

  get(
    name: string,
    sf?: LuaStackFrame,
  ): Promise<LuaValue> | LuaValue | undefined {
    if (this.variables.has(name)) {
      return this.variables.get(name);
    }
    if (this.parent) {
      return this.parent.get(name, sf);
    }
    return undefined;
  }

  /**
   * Lists all keys in the environment including its parents
   */
  keys(): string[] {
    const keys = Array.from(this.variables.keys());
    if (this.parent) {
      return keys.concat(this.parent.keys());
    }
    return keys;
  }
}

export class LuaStackFrame {
  constructor(
    readonly threadLocal: LuaEnv,
    readonly astCtx: ASTCtx | null,
    readonly parent?: LuaStackFrame,
  ) {
  }

  withCtx(ctx: ASTCtx): LuaStackFrame {
    return new LuaStackFrame(this.threadLocal, ctx, this);
  }

  static lostFrame = new LuaStackFrame(new LuaEnv(), null);
}

export class LuaMultiRes {
  values: any[];

  constructor(values: LuaValue[] | LuaValue) {
    if (values instanceof LuaMultiRes) {
      this.values = values.values;
    } else {
      this.values = Array.isArray(values) ? values : [values];
    }
  }

  unwrap(): any {
    if (this.values.length === 0) {
      return null;
    }
    return this.values[0];
  }

  // Takes an array of either LuaMultiRes or LuaValue and flattens them into a single LuaMultiRes
  flatten(): LuaMultiRes {
    const result: any[] = [];
    for (const value of this.values) {
      if (value instanceof LuaMultiRes) {
        result.push(...value.values);
      } else {
        result.push(value);
      }
    }
    return new LuaMultiRes(result);
  }
}

export function singleResult(value: any): any {
  if (value instanceof LuaMultiRes) {
    return value.unwrap();
  } else {
    return value;
  }
}

export class LuaFunction implements ILuaFunction {
  constructor(readonly body: LuaFunctionBody, private closure: LuaEnv) {
  }

  call(sf: LuaStackFrame, ...args: LuaValue[]): Promise<LuaValue> | LuaValue {
    // Create a new environment for this function call
    const env = new LuaEnv(this.closure);
    if (!sf) {
      console.trace(sf);
    }
    env.setLocal("_CTX", sf.threadLocal);
    // Assign the passed arguments to the parameters
    for (let i = 0; i < this.body.parameters.length; i++) {
      let arg = args[i];
      if (arg === undefined) {
        arg = null;
      }
      env.setLocal(this.body.parameters[i], arg);
    }
    return evalStatement(this.body.block, env, sf).catch((e: any) => {
      if (e instanceof LuaReturn) {
        if (e.values.length === 0) {
          return;
        } else if (e.values.length === 1) {
          return e.values[0];
        } else {
          return new LuaMultiRes(e.values);
        }
      } else {
        throw e;
      }
    });
  }

  toString(): string {
    return `<lua function(${this.body.parameters.join(", ")})>`;
  }
}

export class LuaNativeJSFunction implements ILuaFunction {
  constructor(readonly fn: (...args: JSValue[]) => JSValue) {
  }

  // Performs automatic conversion between Lua and JS values
  call(_sf: LuaStackFrame, ...args: LuaValue[]): Promise<LuaValue> | LuaValue {
    const result = this.fn(...args.map(luaValueToJS));
    if (result instanceof Promise) {
      return result.then(jsToLuaValue);
    } else {
      return jsToLuaValue(result);
    }
  }

  toString(): string {
    return `<native js function: ${this.fn.name}>`;
  }
}

export class LuaBuiltinFunction implements ILuaFunction {
  constructor(
    readonly fn: (sf: LuaStackFrame, ...args: LuaValue[]) => LuaValue,
  ) {
  }

  call(sf: LuaStackFrame, ...args: LuaValue[]): Promise<LuaValue> | LuaValue {
    return this.fn(sf, ...args);
  }

  toString(): string {
    return `<builtin lua function>`;
  }
}

export class LuaTable implements ILuaSettable, ILuaGettable {
  // To optimize the table implementation we use a combination of different data structures
  // When tables are used as maps, the common case is that they are string keys, so we use a simple object for that
  private stringKeys: Record<string, any>;
  // Other keys we can support using a Map as a fallback
  private otherKeys: Map<any, any> | null;
  // When tables are used as arrays, we use a native JavaScript array for that
  private arrayPart: any[];

  public metatable: LuaTable | null;

  constructor(init?: any[] | Record<string, any>) {
    // For efficiency and performance reasons we pre-allocate these (modern JS engines are very good at optimizing this)
    this.arrayPart = Array.isArray(init) ? init : [];
    this.stringKeys = init && !Array.isArray(init) ? init : {};
    this.otherKeys = null; // Only create this when needed
    this.metatable = null;
  }

  get length(): number {
    return this.arrayPart.length;
  }

  keys(): any[] {
    const keys: any[] = Object.keys(this.stringKeys);
    for (let i = 0; i < this.arrayPart.length; i++) {
      keys.push(i + 1);
    }
    if (this.otherKeys) {
      for (const key of this.otherKeys.keys()) {
        keys.push(key);
      }
    }
    return keys;
  }

  has(key: LuaValue) {
    if (typeof key === "string") {
      return this.stringKeys[key] !== undefined;
    } else if (Number.isInteger(key) && key >= 1) {
      return this.arrayPart[key - 1] !== undefined;
    } else if (this.otherKeys) {
      return this.otherKeys.has(key);
    }
    return false;
  }

  rawSet(key: LuaValue, value: LuaValue) {
    if (typeof key === "string") {
      this.stringKeys[key] = value;
    } else if (Number.isInteger(key) && key >= 1) {
      this.arrayPart[key - 1] = value;
    } else {
      if (!this.otherKeys) {
        this.otherKeys = new Map();
      }
      this.otherKeys.set(key, value);
    }
  }

  set(
    key: LuaValue,
    value: LuaValue,
    sf?: LuaStackFrame,
  ): Promise<void> | void {
    if (this.metatable && this.metatable.has("__newindex") && !this.has(key)) {
      // Invoke the meta table!
      const metaValue = this.metatable.get("__newindex", sf);
      if (metaValue.then) {
        // This is a promise, we need to wait for it
        return metaValue.then((metaValue: any) => {
          return luaCall(metaValue, [this, key, value], metaValue.ctx, sf);
        });
      } else {
        return luaCall(metaValue, [this, key, value], metaValue.ctx, sf);
      }
    }

    // Just set the value
    this.rawSet(key, value);
  }

  rawGet(key: LuaValue): LuaValue | null {
    if (typeof key === "string") {
      return this.stringKeys[key];
    } else if (Number.isInteger(key) && key >= 1) {
      return this.arrayPart[key - 1];
    } else if (this.otherKeys) {
      return this.otherKeys.get(key);
    }
  }

  get(key: LuaValue, sf?: LuaStackFrame): LuaValue | Promise<LuaValue> | null {
    const value = this.rawGet(key);
    if (value === undefined || value === null) {
      if (this.metatable && this.metatable.has("__index")) {
        // Invoke the meta table
        const metaValue = this.metatable.get("__index", sf);
        if (metaValue.then) {
          // Got a promise, we need to wait for it
          return metaValue.then((metaValue: any) => {
            if (metaValue.call) {
              return metaValue.call(sf, this, key);
            } else if (metaValue instanceof LuaTable) {
              return metaValue.get(key, sf);
            } else {
              throw new Error("Meta table __index must be a function or table");
            }
          });
        } else {
          if (metaValue.call) {
            return metaValue.call(sf, this, key);
          } else if (metaValue instanceof LuaTable) {
            return metaValue.get(key, sf);
          } else {
            throw new Error("Meta table __index must be a function or table");
          }
        }
      } else {
        return null;
      }
    } else {
      return value;
    }
  }

  insert(value: LuaValue, pos: number) {
    this.arrayPart.splice(pos - 1, 0, value);
  }

  remove(pos: number) {
    this.arrayPart.splice(pos - 1, 1);
  }

  async sort(fn?: ILuaFunction, sf?: LuaStackFrame) {
    if (fn && sf) {
      this.arrayPart = await asyncQuickSort(this.arrayPart, async (a, b) => {
        return (await fn.call(sf, a, b)) ? -1 : 1;
      });
    } else {
      this.arrayPart.sort();
    }
  }

  asJSObject(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const key of this.keys()) {
      result[key] = luaValueToJS(this.get(key));
    }
    return result;
  }

  asJSArray(): any[] {
    return this.arrayPart.map(luaValueToJS);
  }

  async toStringAsync(): Promise<string> {
    if (this.metatable?.has("__tostring")) {
      const metaValue = await this.metatable.get("__tostring");
      if (metaValue.call) {
        return metaValue.call(LuaStackFrame.lostFrame, this);
      } else {
        throw new Error("Meta table __tostring must be a function");
      }
    }
    let result = "{";
    let first = true;
    for (const key of this.keys()) {
      if (first) {
        first = false;
      } else {
        result += ", ";
      }
      if (typeof key === "number") {
        result += await luaToString(this.get(key));
        continue;
      }
      if (typeof key === "string") {
        result += key;
      } else {
        result += "[" + key + "]";
      }
      result += " = " + await luaToString(this.get(key));
    }
    result += "}";
    return result;
  }
}

export type LuaLValueContainer = { env: ILuaSettable; key: LuaValue };

export function luaSet(obj: any, key: any, value: any, sf: LuaStackFrame) {
  if (!obj) {
    throw new LuaRuntimeError(
      `Not a settable object: nil`,
      sf,
    );
  }

  if (obj instanceof LuaTable || obj instanceof LuaEnv) {
    obj.set(key, value, sf);
  } else {
    obj[key] = value;
  }
}

export function luaGet(
  obj: any,
  key: any,
  sf: LuaStackFrame,
): Promise<any> | any {
  if (!obj) {
    throw new LuaRuntimeError(
      `Attempting to index a nil value`,
      sf,
    );
  }
  if (key === null || key === undefined) {
    throw new LuaRuntimeError(
      `Attempting to index with a nil key`,
      sf,
    );
  }

  if (obj instanceof LuaTable || obj instanceof LuaEnv) {
    return obj.get(key, sf);
  } else if (typeof key === "number") {
    return obj[key - 1];
  } else {
    // Native JS object
    const val = obj[key];
    if (typeof val === "function") {
      // Automatically bind the function to the object
      return val.bind(obj);
    } else {
      return val;
    }
  }
}

export function luaLen(obj: any): number {
  if (obj instanceof LuaTable) {
    return obj.length;
  } else if (Array.isArray(obj)) {
    return obj.length;
  } else {
    return 0;
  }
}

export function luaCall(
  fn: any,
  args: any[],
  ctx: ASTCtx,
  sf?: LuaStackFrame,
): any {
  if (!fn) {
    throw new LuaRuntimeError(
      `Attempting to call a nil value`,
      (sf || LuaStackFrame.lostFrame).withCtx(ctx),
    );
  }
  if (typeof fn === "function") {
    const jsArgs = args.map(luaValueToJS);
    // Native JS function
    return fn(...jsArgs);
  }
  if (!fn.call) {
    throw new LuaRuntimeError(
      `Attempting to call a non-callable value`,
      (sf || LuaStackFrame.lostFrame).withCtx(ctx),
    );
  }
  return fn.call((sf || LuaStackFrame.lostFrame).withCtx(ctx), ...args);
}

export function luaTypeOf(val: any): LuaType {
  if (val === null || val === undefined) {
    return "nil";
  } else if (typeof val === "boolean") {
    return "boolean";
  } else if (typeof val === "number") {
    return "number";
  } else if (typeof val === "string") {
    return "string";
  } else if (val instanceof LuaTable) {
    return "table";
  } else if (Array.isArray(val)) {
    return "table";
  } else if (typeof val === "function" || val.call) {
    return "function";
  } else {
    return "userdata";
  }
}

// Both `break` and `return` are implemented by exception throwing
export class LuaBreak extends Error {
}

export class LuaReturn extends Error {
  constructor(readonly values: LuaValue[]) {
    super();
  }
}

export class LuaRuntimeError extends Error {
  constructor(
    override readonly message: string,
    public sf: LuaStackFrame,
    cause?: Error,
  ) {
    super(message, cause);
  }

  toPrettyString(code: string): string {
    if (!this.sf || !this.sf.astCtx?.from || !this.sf.astCtx?.to) {
      return this.toString();
    }
    let traceStr = "";
    let current: LuaStackFrame | undefined = this.sf;
    while (current) {
      const ctx = current.astCtx;
      if (!ctx || !ctx.from || !ctx.to) {
        break;
      }
      // Find the line and column
      let line = 1;
      let column = 0;
      for (let i = 0; i < ctx.from; i++) {
        if (code[i] === "\n") {
          line++;
          column = 0;
        } else {
          column++;
        }
      }
      traceStr += `* ${
        ctx.ref || "(unknown source)"
      } @ ${line}:${column}:\n   ${code.substring(ctx.from, ctx.to)}\n`;
      current = current.parent;
    }

    return `LuaRuntimeError: ${this.message} ${traceStr}`;
  }

  override toString() {
    return `LuaRuntimeError: ${this.message} at ${this.sf.astCtx?.from}, ${this.sf.astCtx?.to}`;
  }
}

export function luaTruthy(value: any): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (value instanceof LuaTable) {
    return value.length > 0;
  }
  return true;
}

export function luaToString(value: any): string | Promise<string> {
  if (value === null || value === undefined) {
    return "nil";
  }
  if (value.toStringAsync) {
    return value.toStringAsync();
  }
  if (value.toString) {
    return value.toString();
  }
  return String(value);
}

export function jsToLuaValue(value: any): any {
  if (value instanceof Promise) {
    return value.then(luaValueToJS);
  }
  if (value instanceof LuaTable) {
    return value;
  } else if (Array.isArray(value)) {
    const table = new LuaTable();
    for (let i = 0; i < value.length; i++) {
      table.set(i + 1, jsToLuaValue(value[i]));
    }
    return table;
  } else if (typeof value === "object") {
    const table = new LuaTable();
    for (const key in value) {
      table.set(key, jsToLuaValue(value[key]));
    }
    return table;
  } else if (typeof value === "function") {
    return new LuaNativeJSFunction(value);
  } else {
    return value;
  }
}

// Inverse of jsToLuaValue
export function luaValueToJS(value: any): any {
  if (value instanceof Promise) {
    return value.then(luaValueToJS);
  }
  if (value instanceof LuaTable) {
    // We'll go a bit on heuristics here
    // If the table has a length > 0 we'll assume it's a pure array
    // Otherwise we'll assume it's a pure object
    if (value.length > 0) {
      const result = [];
      for (let i = 0; i < value.length; i++) {
        result.push(luaValueToJS(value.get(i + 1)));
      }
      return result;
    } else {
      const result: Record<string, any> = {};
      for (const key of value.keys()) {
        result[key] = luaValueToJS(value.get(key));
      }
      return result;
    }
  } else if (value instanceof LuaNativeJSFunction) {
    return (...args: any[]) => {
      return jsToLuaValue(value.fn(...args.map(luaValueToJS)));
    };
  } else {
    return value;
  }
}
