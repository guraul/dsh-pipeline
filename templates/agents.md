# {{REPO}} - 项目说明

**Updated:** {{DATE}}

项目知识库在 `{{KB_DIR}}/`，本文件只承担**路由**与**强制规定**两个职责。功能细节、命令面、数据落盘一律查知识库与 `docs/CONTRACT.md`，不要在本文重复。

## 知识库路由（优先查阅）

| 场景 | 加载文档 |
|------|----------|
| 全局认知、技术栈、目录地图、速查 | `{{KB_DIR}}/INDEX.md`（每次对话优先） |
| 理解分层架构、数据流、数据模型 | `{{KB_DIR}}/ARCHITECTURE.md` |
| 接口清单、命令面、导出 | `{{KB_DIR}}/API.md` |
| 产物落在哪、怎么查数据 | `{{KB_DIR}}/DATA.md` |
| 测试 / 打包 / CI / 部署 / 环境变量 | `{{KB_DIR}}/OPERATIONS.md` |
| 编码约定、历史包袱、修改红线 | `{{KB_DIR}}/CONVENTIONS.md` |
{{MODULES_ROWS}}
| **契约（唯一规范来源）** | `docs/CONTRACT.md` |

## 查询流程

先基于知识库定位涉及模块与文件，给出方案；信息不足时再针对性读源码片段，不要全量读码。保鲜判定（`git log --oneline <stamp>..HEAD -- <覆盖路径>`）与回写规则见 `~/.dsh/AGENTS.md` §13，本文不复述。

## 强制规定

{{RULES}}

## 常用命令

{{COMMANDS}}
