import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'

/**
 * 路径是不是**普通文件** —— 判据是文件**类型**，不是存在性。
 *
 * `existsSync` 对 FIFO、socket、设备节点、目录一律为真，而 `readFileSync` 读一个
 * 没有写者的 FIFO 会**阻塞到有写者打开它为止**。于是 `mkfifo ~/.mipham/config.yml`
 * 这一条命令（或某个崩掉的工具留在 `~/.mipham/` 下的 socket）就能让 CLI 启动**永久
 * 挂住**：没有输出、没有报错，也没有任何东西能给它计时 —— 阻塞发生在同步调用里，
 * 定时器与 signal handler 都排不上队。闸门只能架在文件类型上。
 *
 * 符号链接指向普通文件**算数**（`statSync` 跟随链接，`~/.mipham` 常被软链进
 * dotfiles 仓库）；指向 FIFO 的不算。
 *
 * 已知边界：stat 与随后的 read 之间不是原子的 —— 恰好在那道缝里把路径换成 FIFO
 * 仍会阻塞。不设防：能改你配置路径的人本来就能做更坏的事。
 */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    // 不存在（ENOENT）、路径中有一段不是目录（ENOTDIR）、权限不足（EACCES）、
    // 链接成环（ELOOP）—— 对调用方都是同一件事：这里没有能读的内容。
    return false
  }
}

/**
 * 读一个**普通文件**的文本内容；没有可读的普通文件时返回 null。
 *
 * null 的含义是「这里没有可读的普通文件」，三种来源一视同仁：缺失、不是普通文件
 * （FIFO / socket / 目录 / 设备节点）、是普通文件但读不动（权限等）。
 *
 * 本函数**不往 stderr 写任何东西** —— 多数调用点读的是可选覆盖层，「文件不在」是
 * 常态。需要提示的调用点自己判断（见 `config/loader.ts` 的 `safeParseYaml`）。
 */
export function readRegularFileSync(path: string): string | null {
  if (!isRegularFile(path)) return null
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 追加写入，只在目标**是普通文件或还不存在**时才写；返回是否真的写了。
 *
 * `appendFileSync` 会**打开目标写** —— 目标若是 FIFO 就等到有读者为止，与读侧同一个
 * 坑，只是撞在写这一侧（配置备份的 `copyFileSync` 当初也是这么挂住的）。「还不存在」
 * 必须放行：追加写天然承担创建。
 *
 * 返回 `false` 的意思是**没写**，调用方得知道自己丢了什么 —— 别把「跳过」当成功。
 */
export function appendRegularFileSync(
  path: string,
  content: string,
  options: { mode?: number } = {},
): boolean {
  if (existsSync(path) && !isRegularFile(path)) return false
  appendFileSync(path, content, { encoding: 'utf-8', mode: options.mode ?? 0o600 })
  return true
}
