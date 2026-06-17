# 部署 Next.js 到 Cloudflare

把 Next.js 部署到 Cloudflare Pages 时，常见的坑是 Node API 不被 edge runtime 支持、以及环境变量注入方式不同。需要确认使用的依赖是否兼容 edge。

数据库层如果用 Postgres，可以配合 Drizzle ORM；要做向量检索可以用 pgvector，Drizzle 已经原生支持 vector 列。
