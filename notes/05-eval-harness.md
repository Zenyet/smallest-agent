# Eval 与 Harness

做出能 demo 的 Agent 不难，做出能上线的 Agent 99% 是 eval 工作。Eval 是在没有标准答案的情况下客观衡量好坏，常见打分方式有 exact match、程序化校验、LLM-as-Judge、人工标注。

Harness 是跑 eval 的那套基础设施：准备测试集、组织运行、自动打分。测试集是会增值的资产，用户每用一次就能发现新的 bad case，加进去变成永久回归。
