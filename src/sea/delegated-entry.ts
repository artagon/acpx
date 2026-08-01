#!/usr/bin/env node

import { main } from "../cli-core.js";
import { installBrokenPipeHandler } from "../cli/broken-pipe.js";

installBrokenPipeHandler(process.stdout, "exit");
installBrokenPipeHandler(process.stderr, "exit");

void main(process.argv);
