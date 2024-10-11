import type { FileMeta } from "../../../plug-api/types.ts";
import { assert } from "@std/assert";
import fileSystemSyscalls from "./fs.deno.ts";
import { dirname, resolve } from "@std/path";

Deno.test("Test FS operations", async () => {
  const thisFolder = resolve(
    dirname(new URL(import.meta.url).pathname),
  );
  const syscalls = fileSystemSyscalls(thisFolder);
  const allFiles: FileMeta[] = await syscalls["fs.listFiles"](
    {},
    thisFolder,
    true,
  );
  assert(allFiles.find((f) => f.name === "fs.deno.test.ts"));
});
