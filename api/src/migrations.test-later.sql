-- 只有测试用。ALTER TABLE 跑第二遍会报 duplicate column，正好用来验不会重跑。
ALTER TABLE extra ADD COLUMN note TEXT;
