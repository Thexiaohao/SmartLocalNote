# -*- coding: utf-8 -*-
"""03 · 核心脚本示例（用于验证源码视图渲染，# 注释不应被误解析为 Markdown H1 标题）."""

from pathlib import Path
import json


# 1. 初始化路径安全检查
def summarize_tasks(config_path: str) -> dict:
    # 读取 JSON 配置文件并统计模块数
    raw = Path(config_path).read_text(encoding="utf-8")
    data = json.loads(raw)
    modules = data.get("supported_formats", [])
    return {
        "project": data.get("project", "SmartLocalNote"),
        "version": data.get("version", "6.0.0"),
        "format_count": len(modules),
    }


# 2. 计算任务进度统计
def calc_completion_rate(done: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((done / total) * 100.0, 1)


if __name__ == "__main__":
    print("SmartLocalNote V6 Source Code Preview OK ->", calc_completion_rate(12, 13))
