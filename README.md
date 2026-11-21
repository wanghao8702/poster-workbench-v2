<div align="center">

# 海报工作台 V2

**生成一张海报，再拆成每一个图层。**

给企业人力资源部、培训部门用的本地海报工具：AI 生图 → 拆成透明图层 → 拖动调整 → 导出。

</div>

---

基于 [Cover Studio](../cover-studio) 二次开发。主要改动：

- 品类改为 **封面图 / 培训海报 / 自由创作**（去掉了小红书和电商海报）。
- **培训海报**：在弹窗里填写主题、受众、时间地点、文案、课程内容和讲师，保存后自动拼出完整提示词。视觉风格、配色与版式交给 AI 判断。
- 支持**讲师肖像参考图**（需使用千问生图），让海报上的讲师与本人一致。
- 设置区由折叠展开改为**弹窗**，保存后更新完整提示词；手动改过的提示词不会被悄悄覆盖。
- 只做本地版本，已移除 Cloudflare 部署。

> 不填 API Key 也可以点「载入示例」，体验示例培训海报的 8 个图层。生成新图需要千问或 MaaS 的 Key，拆层需要 MaaS 的 Key。

## 快速开始

### 环境要求

| 环境 | 用途 |
| --- | --- |
| Python 3.10+ | 本地服务，仅使用标准库，无需安装依赖 |
| 千问（阿里云百炼）API Key | 生图，支持讲师肖像参考图 |
| 蚂蚁数科 MaaS API Key | 拆层；也可用于生图（不支持肖像参考） |
| Node.js 20+（可选） | 仅用于运行前端检查脚本 |

### 启动

- **Windows**：双击 `启动.bat`。它会依次尝试 `py -3`、`python`、`python3`，启动后自动打开浏览器；没找到 Python 时会提示去安装。关闭命令行窗口即停止服务。
- **命令行**：`python server.py --open`（指定端口：`python server.py --port 8766`）
- **macOS**：双击 `启动.command`

打开 [http://127.0.0.1:8765](http://127.0.0.1:8765)，在右上角「API 设置」填写 Key。服务只监听本机 `127.0.0.1`。

### 使用流程

1. **生成**：选择品类。培训海报点「填写培训信息」，填完点「保存并更新提示词」；封面图点「风格与标题设置」，在示例图里点选风格。左栏的完整提示词仍然可以手动修改。选好画面比例后点「生成图片」。
2. **拆解**：点「继续拆解图层」，也可以上传已有图片；确认图层规划后开始拆解。
3. **编辑**：在画布中选择图层，拖动位置、缩放大小，在右侧调整显隐和叠放顺序。
4. **导出**：下载原图、编辑后的合成 PNG、单层 PNG，或原始图层 ZIP。

## 培训海报

弹窗字段：培训主题（必填）、目标受众（可多选）、日期、时间、形式（线下 / 线上 / 混合）、地点、主标题（留空则用主题）、副标题、行动号召、课程内容（每行一条），以及讲师（最多 6 位：肖像、姓名、头衔、资历、姿势、着装）和讲师呈现方式（主讲人出镜 / 肖像 + 简介 / 仅文字）。

- **AI 识别填入**：弹窗顶部点「AI 识别填入」，粘贴培训通知，或上传 `.txt` / `.md` / `.docx` 文件，千问文本模型会提取主题、时间地点、文案、课程要点和讲师，填进表单。识别结果替换整张表单（讲师肖像按姓名保留，呈现方式不变），标黄的是识别出的内容，核对后再保存；点「取消」可恢复原表单。原文超过 2 万字时只识别前 2 万字。旧版 `.doc` 和 PDF 暂不支持，请另存为 `.docx` 或复制文字粘贴。
- 文字字段保存在当前浏览器，刷新后保留；**讲师肖像不保存**，刷新后需重新上传。
- 肖像上传后会在浏览器内压缩为长边不超过 1600 px 的 JPEG。
- `qwen-image-2.1` 系列模型一次最多参考 10 张肖像，其他千问模型最多 3 张。超出的讲师按虚构形象绘制，弹窗里会提前提示。
- 生图接口选 MaaS 时不支持肖像参考，讲师按虚构形象绘制，生成按钮上方会提示。
- 切换生图接口、模型或画面比例后：提示词没手动改过的会自动重新拼装；改过的不会被覆盖，提示词上方会出现「重新拼装」按钮。

## API 设置

| 分组 | 字段 | 默认值 |
| --- | --- | --- |
| 生图接口 | 千问 / MaaS | 千问 |
| 千问 | API Key、生图模型、文本模型、Base URL | `qwen-image-3.0-pro`、`qwen-plus`、`https://dashscope.aliyuncs.com/api/v1` |
| 拆层接口 | MaaS API Key | — |

- Base URL 带 `/api/v1` 时走百炼原生图像接口；百炼官方域名的 `/compatible-mode/v1` 地址也会自动改走原生接口（兼容模式没有图像接口）。只接受 `https://` 地址。
- 生图接口、模型和 Base URL 会记在浏览器里；**Key 只保存在当前页面**，刷新后需重新填写。
- **推荐把 Key 和设置写进项目根目录的 `.env`**（从 `.env.example` 复制，已加入 `.gitignore`，不会被提交）：

  | 变量 | 作用 | 默认 |
  | --- | --- | --- |
  | `QWEN_API_KEY` | 百炼 Key：千问生图、AI 识别填入 | 空 |
  | `MAAS_API_KEY` | MaaS Key：拆层，以及选 MaaS 时的生图 | 空 |
  | `GEN_PROVIDER` | 生图接口：`qwen` / `maas` | `qwen` |
  | `QWEN_IMAGE_MODEL` | 千问生图模型 | `qwen-image-3.0-pro` |
  | `QWEN_TEXT_MODEL` | 千问文本模型 | `qwen-plus` |
  | `QWEN_BASE_URL` | 百炼地址 | `https://dashscope.aliyuncs.com/api/v1` |
  | `PORT` | 本地服务端口 | `8765` |

  改完刷新浏览器即可生效（只有 `PORT` 需要重启 `启动.bat`）。`.env` 里填了的设置会覆盖浏览器记住的值；在页面「API 设置」里临时改 Key 只对当前页面有效，不会写回 `.env`。
- 旧版的 `.local-key`（MaaS）和 `.local-qwen-key`（千问）仍然可用，`.env` 里对应的 Key 为空时才读它们。

比例与千问出图尺寸：

| 比例 | 尺寸 |
| --- | --- |
| 1:1 | 1328 × 1328 |
| 3:4 | 1140 × 1472 |
| 4:3 | 1472 × 1140 |
| 9:16 | 928 × 1664 |
| 16:9 | 1664 × 928 |
| 5:2 | 按 1664 × 928 出图，提示词中仍写 5:2 |
| 自动 | 培训海报 3:4、封面图 16:9、自由创作 1:1 |

## 数据与隐私

- 生成和拆层结果保存在项目下的 `output/`，每个任务一个文件夹，包含图片、`manifest.json`、`prompt.txt` 和 `images.zip`。千问任务另存所用的讲师肖像 `ref-01.jpg …`，仅用于留档，不进 ZIP。
- **讲师肖像会发送给你配置的千问服务**，请确认已获得讲师本人同意。
- 使用 AI 识别填入时，粘贴的文字或上传的文件内容会发送给千问文本模型（同一个百炼 Key），不会保存到 `output/`。
- API Key 不会写入素材记录、日志或报错信息。
- 素材库保存模型原始输出，拖动、缩放和显隐等编辑状态不自动保存，请导出合成 PNG。

## 模型接入

| 能力 | 服务 | 模型 | 接口 |
| --- | --- | --- | --- |
| 生图（默认） | 阿里云百炼 | `qwen-image-3.0-pro`（可改） | `POST /api/v1/services/aigc/multimodal-generation/generation` |
| 生图（可选） | 蚂蚁数科 MaaS | `ming-image-0.1-design` | `POST /v1/images/generations` |
| 拆层 | 蚂蚁数科 MaaS | `ming-image-0.1-design-layer` | `POST /v1/images/edits` |

千问接入逻辑移植自 `ref培训海报生成器/ai-proxy.js`，位于 `qwen_client.py`。

## 项目结构

```text
海报工作台V2/
├── static/
│   ├── index.html
│   ├── app.js               # 创作流程、弹窗、API 设置与图层编辑器
│   ├── training-prompt.js   # 培训海报提示词编译器（纯函数，可单测）
│   ├── training-form.js     # 培训信息弹窗表单
│   ├── punk-cover.js        # 封面风格提示词编译器
│   ├── config.js            # 读取本机默认 Key
│   └── style.css
├── server.py                # Python 本地服务：任务队列、素材库、MaaS 调用
├── qwen_client.py           # 千问 / 百炼图像接口
├── training_extract.py      # 读取 txt / md / docx，调用千问文本模型识别培训信息
├── test_server.py / test_qwen.py / test_extract.py / test_training.cjs / test_layers.cjs / test_app.cjs
├── vendor/punk-skill/       # 第三方风格规则来源与许可
├── docs/                    # 开发文档（见 docs/README.md）、初版设计与实施计划
├── 启动.bat                  # Windows 启动入口
└── 启动.command              # macOS 启动入口
```

**继续开发或维护前，请先读 [docs/接手指南.md](docs/接手指南.md)**。全部开发文档见 [docs/README.md](docs/README.md)：接手指南、技术架构、接口文档、开发规范、变更日志、问题待办。

## 检查

```bash
python -m unittest test_server.py test_qwen.py test_extract.py
node test_training.cjs
node test_layers.cjs
node test_app.cjs
node --check static/app.js   # 其余 static/*.js 同理
```

这些检查不需要真实 API Key，也不会调用付费模型。

## 已知限制

- 拆出的文字是像素图片，不能直接作为文本修改。
- 模型可能把多个元素合并到同一层，实际层数、顺序与透明边缘需要检查。
- 千问出图尺寸按上表固定；若所选模型不支持某个尺寸，需要调整 `qwen_client.py` 中的 `SIZES`。
- 模型处理期间请保持页面打开。

## 第三方来源

| 来源 | 集成内容 | 固定版本 |
| --- | --- | --- |
| [Punk-Skill](https://github.com/adrianpunk/Punk-Skill) | 31 种封面与海报风格规则，以及风格示例图（`static/punk-thumbs/`，由仓库 `screenshots/punk-cover-styles/` 缩小为 640 px 宽的 JPEG） | `v1.0.0-mit`，提交 `0380629c81b4cc6870722cb99fb6fe0ee416b56f` |

Punk 集成仅使用上述 MIT 历史版本。原始来源与授权文件保留在 `vendor/`，许可证另见 [static/punk-license.txt](static/punk-license.txt)。

## 许可证

项目原创代码尚未指定开源许可证。第三方内容按其各自上游许可使用。
