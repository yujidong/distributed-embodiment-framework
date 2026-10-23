/**
 * R2-FEAT-12: zone/room 显示名规则（漫游标签 / E 房间卡片 / 搜索 / 信标共用）。
 * name 与 code 不同时显示 name（「101 病房」「客厅」），相同或缺失时回退 code
 * （太仓预烘焙标签 name===code，行为不变）；zone-as-room 的 zone id 绝不裸显。
 */
export function roomLabelText(label: { code: string; name?: string | null }): string {
  const name = label.name ?? '';
  return name !== '' && name !== label.code ? name : label.code;
}
