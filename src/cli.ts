#!/usr/bin/env node
import { main } from "./run-cli";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
