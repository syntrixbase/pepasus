/**
 * Built-in tools - all available tools.
 */

import type { Tool } from "../types.ts";

// System tools
import * as systemToolsModule from "./system-tools.ts";
const current_time = systemToolsModule.current_time;
const sleep = systemToolsModule.sleep;
const get_env = systemToolsModule.get_env;
const set_env = systemToolsModule.set_env;

export { current_time, sleep, get_env, set_env };

// File tools
import * as fileToolsModule from "./file-tools.ts";
const read_file = fileToolsModule.read_file;
const write_file = fileToolsModule.write_file;
const list_files = fileToolsModule.list_files;
const delete_file = fileToolsModule.delete_file;
const move_file = fileToolsModule.move_file;
const get_file_info = fileToolsModule.get_file_info;

export { read_file, write_file, list_files, delete_file, move_file, get_file_info };

// Network tools
import * as networkToolsModule from "./network-tools.ts";
const http_get = networkToolsModule.http_get;
const http_post = networkToolsModule.http_post;
const http_request = networkToolsModule.http_request;
const web_search = networkToolsModule.web_search;

export { http_get, http_post, http_request, web_search };

// Data tools
import * as dataToolsModule from "./data-tools.ts";
const json_parse = dataToolsModule.json_parse;
const json_stringify = dataToolsModule.json_stringify;
const base64_encode = dataToolsModule.base64_encode;
const base64_decode = dataToolsModule.base64_decode;

export { json_parse, json_stringify, base64_encode, base64_decode };

// Memory tools
import * as memoryToolsModule from "./memory-tools.ts";
const memory_list = memoryToolsModule.memory_list;
const memory_read = memoryToolsModule.memory_read;
const memory_write = memoryToolsModule.memory_write;
const memory_append = memoryToolsModule.memory_append;

export { memory_list, memory_read, memory_write, memory_append };

// Task tools
import * as taskToolsModule from "./task-tools.ts";
const task_list = taskToolsModule.task_list;
const task_replay = taskToolsModule.task_replay;

export { task_list, task_replay };

// Spawn task tool (for Main Agent)
import * as spawnTaskModule from "./spawn-task-tool.ts";
const spawn_task = spawnTaskModule.spawn_task;

export { spawn_task };

// Re-export all tools as array
export const systemTools: Tool[] = [
  current_time,
  sleep,
  get_env,
  set_env,
  spawn_task,
];

export const fileTools: Tool[] = [
  read_file,
  write_file,
  list_files,
  delete_file,
  move_file,
  get_file_info,
];

export const networkTools: Tool[] = [
  http_get,
  http_post,
  http_request,
  web_search,
];

export const dataTools: Tool[] = [
  json_parse,
  json_stringify,
  base64_encode,
  base64_decode,
];

export const memoryTools: Tool[] = [
  memory_list,
  memory_read,
  memory_write,
  memory_append,
];

export const taskTools: Tool[] = [
  task_list,
  task_replay,
];

export const allBuiltInTools: Tool[] = [
  ...systemTools,
  ...fileTools,
  ...networkTools,
  ...dataTools,
  ...memoryTools,
  ...taskTools,
];
