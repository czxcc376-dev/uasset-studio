# 测试夹具

`TestAsset.uasset` / `TestAsset.uexp` 由 `scripts/make-fixture.mjs` 按 UE4 序列化格式**手工构造**，
不是从任何游戏里提取的资产。用途：在 CI 里验证解析器与回写器，无需分发真实资产。

结构：1 个导出（Default__TestAsset_C），含 Float / Bool / Int / Str / Struct(Vector) 五类属性。
重新生成：`node scripts/make-fixture.mjs`
