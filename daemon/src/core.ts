// 唯一引用 core/ 的地方。和 api/src/core.ts 同样的用意：
// core/ 换成 Rust 时两个可执行体各只有一个缝合点。
//
// 借类型和调谐规划。复制一份 Activity 会在字段改了之后悄悄对不上。调谐规划
// 要和 api 的校验、设置页的提示是同一个算法，否则界面说行，接收机调不过去。

export type { Activity, Origin } from '../../core/src/index.ts';
export { planTuning, readAnalogChannels } from '../../core/src/tuning.ts';
