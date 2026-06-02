#!/usr/bin/env bun
import { Command } from 'commander'
import { runApp } from '../src/index'

const program = new Command()

program
  .name('mipham')
  .description('Mipham Code — Multi-model open-core intelligent coding terminal')
  .version('0.1.0')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider to use')
  .option('--lang <lang>', 'CLI interface language')
  .option('--permission <level>', 'Permission level: auto, ask, bypass')
  .action(async (options) => {
    await runApp(options)
  })

program.parse()
