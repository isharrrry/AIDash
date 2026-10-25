import { VERSION } from '../constants.js';

export function helpText() {
  return `aidash-runner ${VERSION} — AIDash 本地值守壳

用法:
  aidash-runner <command> [options]

常驻与执行:
  start                 前台常驻：拉取 pending 任务 → 认领 → 执行 → 回报
  start --daemon        后台常驻；就绪后打印实例 id / pid / 日志路径
  once                  连接一次，最多执行一个任务后退出（不注册为实例）
  dry-run               只读：列出 pending 任务、命中的规则与跳过原因，不认领

查询与控制（默认操作用户自己的本地实例）:
  list [--all]          列出实例；失效记录标记 stale
  status [id]           查看实例状态、当前任务、最近拉取与配置
  pull [id] [--wait]    立即触发一次拉取；忙时排队
  stop [id] [--all] [--force]   优雅停止；--force 超时后强杀
  kill [id] [--all]     直接强杀实例及其 harness 进程树
  logs [id] [-f] [--lines <n>]  查看日志；-f 跟随
  config get [id]       查看运行时配置
  config set [id] <key> <value> [--persist]  修改白名单运行时配置
  config reload [id]    重读配置文件（运行时键立即生效，需重启的键会列出）

初始化与自检:
  init [--config <path>] [--force] [--preset claude] [--command <cmd>] [--cwd <dir>]
                                     生成配置；推荐 --preset claude（argv 直传，无 shell 引号）
  check [--config <path>]            校验配置、命令、目录与令牌可用性
  --version / --help

start 选项:
  --config <path>       指定配置文件（优先于 AIDASH_RUNNER_CONFIG / ./aidash-runner.json / ~/.aidash/runner.json）
  --harness-id <id>     服务端唯一执行者标识；默认 watch-<hostname>
  --name <name>         展示名；默认 hostname
  --url <url>           AIDash MCP 地址；默认 http://127.0.0.1:8787/mcp
  --token <key> | --key <key> | --token-file <path>   凭据来源；优先 AIDASH_TOKEN，
                        其次命令行/文件；AIDASH_PASSPHRASE 仅为弃用别名
  --poll <sec>          空闲轮询间隔；默认 5
  --lease <sec>         任务租约；默认 900
  --heartbeat <sec>     心跳间隔；默认 60
  --gap <sec>           两个任务之间间隔；默认 2
  --channel <pattern>   只处理指定通道，可重复；支持 * 与 prefix/*
  --command <cmd>       按 shell 命令逐字执行（不是自然语言提示词），并创建一条
                        match_all 规则替换配置文件里的 commands；要跑 AI harness，
                        请把 harness 命令写进 command 并让它读取 {task_file}
  --yes                 配合 --command：确认任务清单后继续；不加时只打印清单并退出 0
  --ensure-channel <key> 精确创建/复用通道（start/once 各调一次 channel.upsert）；
                        与 --channel 的匹配过滤不同，本参数不是过滤器
  --channel-title <t>   配合 --ensure-channel 的通道标题（可省）
  --create-task <title> 在 --ensure-channel 的通道创建并提交任务；同通道同标题幂等
  --task-description <md> 配合 --create-task 的任务描述（可省）
  --resume <engine>     仅支持 claude：按通道持久化会话 ID；首次 --session-id，
                        后续 --resume；失败会清旧 ID 并回退一次
  --cwd <dir>           单条规则或 --command 时设置工作目录；也是通道 workdir 的优先值
  --log-file <path>     日志文件；默认 <data-dir>/logs/<instance_id>.log
  --data-dir <path>     实例数据目录；默认 ~/.aidash/runner
  --no-prefix           子进程输出不加 [task_id] 前缀
  --json                机器可读输出（stdout 仅一个 JSON 信封）

通用:
  所有命令都支持 --json。只有一个存活实例时可省略 id；多个实例必须指定 id。

安全:
  MCP 凭据只从 AIDASH_TOKEN / AIDASH_PASSPHRASE / --token / --token-file 读取，
  绝不写入配置文件、registry 或日志。控制面仅绑定 127.0.0.1。
  shell:true 的规则与 --command 会把命令拼成 shell 字符串，请只对可信内容使用。
`;
}
