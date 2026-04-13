const REGION_CODE_MAP: Record<string, string> = {
  // Municipalities
  beijing: 'BJ',
  北京: 'BJ',
  bj: 'BJ',
  tianjin: 'TJ',
  天津: 'TJ',
  tj: 'TJ',
  shanghai: 'SH',
  上海: 'SH',
  sh: 'SH',
  chongqing: 'CQ',
  重庆: 'CQ',
  cq: 'CQ',

  // Provinces
  hebei: 'HEB',
  河北: 'HEB',
  heb: 'HEB',
  shanxi: 'SAX',
  山西: 'SAX',
  sax: 'SAX',
  liaoning: 'LN',
  辽宁: 'LN',
  ln: 'LN',
  jilin: 'JL',
  吉林: 'JL',
  jl: 'JL',
  heilongjiang: 'HLJ',
  黑龙江: 'HLJ',
  hlj: 'HLJ',
  jiangsu: 'JS',
  江苏: 'JS',
  js: 'JS',
  guangdong: 'GD',
  广东: 'GD',
  gd: 'GD',
  zhejiang: 'ZJ',
  浙江: 'ZJ',
  zj: 'ZJ',
  anhui: 'AH',
  安徽: 'AH',
  ah: 'AH',
  fujian: 'FJ',
  福建: 'FJ',
  fj: 'FJ',
  jiangxi: 'JX',
  江西: 'JX',
  jx: 'JX',
  shandong: 'SD',
  山东: 'SD',
  sd: 'SD',
  henan: 'HEN',
  河南: 'HEN',
  hen: 'HEN',
  hubei: 'HUB',
  湖北: 'HUB',
  hub: 'HUB',
  hunan: 'HUN',
  湖南: 'HUN',
  hun: 'HUN',
  hainan: 'HI',
  海南: 'HI',
  hi: 'HI',
  sichuan: 'SC',
  四川: 'SC',
  sc: 'SC',
  guizhou: 'GZ',
  贵州: 'GZ',
  guangzhou: 'GZ',
  广州: 'GZ',
  gz: 'GZ',
  yunnan: 'YN',
  云南: 'YN',
  yn: 'YN',
  shaanxi: 'SNX',
  陕西: 'SNX',
  snx: 'SNX',
  gansu: 'GS',
  甘肃: 'GS',
  gs: 'GS',
  qinghai: 'QH',
  青海: 'QH',
  qh: 'QH',

  // Autonomous regions
  neimenggu: 'NMG',
  innermongolia: 'NMG',
  内蒙古: 'NMG',
  nmg: 'NMG',
  guangxi: 'GX',
  广西: 'GX',
  gx: 'GX',
  xizang: 'XZ',
  tibet: 'XZ',
  西藏: 'XZ',
  xz: 'XZ',
  ningxia: 'NX',
  宁夏: 'NX',
  nx: 'NX',
  xinjiang: 'XJ',
  新疆: 'XJ',
  xj: 'XJ',

  // SAR / Taiwan
  taiwan: 'TW',
  台湾: 'TW',
  tw: 'TW',
  hongkong: 'HK',
  香港: 'HK',
  hk: 'HK',
  macau: 'MO',
  澳门: 'MO',
  mo: 'MO',

  // City aliases requested
  shenzhen: 'SZ',
  深圳: 'SZ',
  sz: 'SZ',
  dongguan: 'DG',
  东莞: 'DG',
  dg: 'DG',
  foshan: 'FS',
  佛山: 'FS',
  fs: 'FS',
  hangzhou: 'HZ',
  杭州: 'HZ',
  hz: 'HZ',
  nanjing: 'NJ',
  南京: 'NJ',
  nj: 'NJ',
  suzhou: 'SUZ',
  苏州: 'SUZ',
  suz: 'SUZ',
  chengdu: 'CD',
  成都: 'CD',
  cd: 'CD',
  wuhan: 'WH',
  武汉: 'WH',
  wh: 'WH',
  changsha: 'CS',
  长沙: 'CS',
  cs: 'CS',
  xian: 'XA',
  西安: 'XA',
  xa: 'XA',
  zhengzhou: 'ZZ',
  郑州: 'ZZ',
  zz: 'ZZ',
  qingdao: 'QD',
  青岛: 'QD',
  qd: 'QD',
  xiamen: 'XM',
  厦门: 'XM',
  xm: 'XM',
};

const CARRIER_CODE_MAP: Record<string, string> = {
  mobile: 'CM',
  移动: 'CM',
  cm: 'CM',
  unicom: 'CU',
  联通: 'CU',
  cu: 'CU',
  telecom: 'CT',
  电信: 'CT',
  ct: 'CT',
};

function normalizeRegionCode(regionName: string): string {
  const raw = regionName.trim();
  if (!raw) return 'OTHER';
  const key = raw.toLowerCase();
  return REGION_CODE_MAP[key] ?? REGION_CODE_MAP[raw] ?? 'OTHER';
}

function normalizeCarrierCode(ispName: string): string {
  const raw = ispName.trim();
  if (!raw) return 'OTHER';
  const key = raw.toLowerCase();
  if (CARRIER_CODE_MAP[key]) return CARRIER_CODE_MAP[key];

  if (key.includes('mobile') || raw.includes('移动')) return 'CM';
  if (key.includes('unicom') || raw.includes('联通')) return 'CU';
  if (key.includes('telecom') || raw.includes('电信')) return 'CT';
  return 'OTHER';
}

export function buildRegionCarrierCode(regionName: string, ispName: string): string {
  const r = normalizeRegionCode(regionName);
  const c = normalizeCarrierCode(ispName);
  if (r === 'OTHER' || c === 'OTHER') return 'OTHER';
  return `${r}_${c}`;
}

export function toRegionCode(regionName: string): string {
  return normalizeRegionCode(regionName);
}
