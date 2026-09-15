// 唯一引用 core/ 的地方。和 api/src/core.ts 同样的用意：
// core/ 换成 Rust 时两个可执行体各只有一个缝合点。
//
// 只借类型。复制一份 Activity 会在字段改了之后悄悄对不上，
// 而 import type 编译后不留一行运行时代码，隔离一点都不少。

export type { Activity, Origin } from '../../core/src/index.ts';
