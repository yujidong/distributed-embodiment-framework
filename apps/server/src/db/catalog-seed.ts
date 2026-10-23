/**
 * Seed catalog — real, purchasable device models (product_design.md §11.3)
 *
 * The bulk of the catalog mirrors the suzhou-apartment scenario's real
 * models; a handful of city-relevant models are added for the upcoming
 * smart-city templates. Every entry's `deviceType` is a semantic type the
 * simulation actually understands (packages/simulation — physics effects in
 * SimulatedDevice.createPhysicsEffect, control loops in controllers.ts,
 * sensor noise in generateSensorNoise), and `physics` values are aligned
 * with those constants:
 *   - hvac:          ±3000 W effect, 4 m radius, thermostat hysteresis ±0.5 °C
 *   - humidifier:    +0.3 %/s, 3 m radius, hysteresis 2 %
 *   - air-purifier:  −(fanSpeed/100)·0.5 PM2.5/s, 5 m radius, idle ≤12 / run ≥20 µg/m³
 *   - light:         0.8 light effect, 4 m radius
 *   - smart-plug:    −0.5 energy effect, 5 m radius
 *   - sensor noise:  temperature ±0.5 °C, humidity ±2 %, light ±10 lux
 *
 * Seeding is idempotent: rows carry fixed `seed-*` ids and are inserted with
 * INSERT OR IGNORE, so reboots never duplicate or overwrite curated rows.
 *
 * Deployment tiers (schema v3): rows without an explicit `tier` land on the
 * 'consumer' default; the municipal/industrial section at the bottom carries
 * real smart-city hardware (air-quality stations, traffic detectors, smart
 * poles, NB-IoT infrastructure) with tier 'municipal' or 'industrial'.
 */

import type { CatalogStore, CreateDeviceModelInput } from './catalog-store.js';
import type { SeedLogger } from './seed.js';

export type SeedDeviceModel = Omit<CreateDeviceModelInput, 'source' | 'status' | 'createdBy'> & {
  id: string;
};
export const CATALOG_SEED_MODELS: SeedDeviceModel[] = [
  // -----------------------------------------------------------------------
  // Suzhou-apartment models (config/scenarios/suzhou-apartment.json)
  // -----------------------------------------------------------------------
  {
    id: 'seed-xiaomi-lywsd03mmc',
    vendor: 'Xiaomi',
    model: 'LYWSD03MMC',
    name: '小米温湿度传感器2',
    deviceType: 'temp-humidity-sensor',
    capabilities: ['temperature-monitoring', 'humidity-monitoring'],
    physics: { temperatureNoiseC: 0.5, humidityNoisePct: 2 },
    specs: { protocol: 'BLE 4.2', powerSupply: 'CR2032 battery', display: 'LCD segment' },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=lywsd03mmc',
    priceCny: 29,
  },
  {
    id: 'seed-gree-kfr-35gw-yunjia',
    vendor: 'Gree',
    model: 'KFR-35GW',
    name: '格力云佳空调（1.5匹）',
    deviceType: 'hvac',
    capabilities: [
      'temperature-control', 'cooling', 'heating', 'set-temperature', 'set-mode',
      'turn-on', 'turn-off',
    ],
    physics: { powerW: 3000, effectRadiusM: 4, hysteresisC: 0.5 },
    specs: {
      coolingCapacityW: 3500, heatingCapacityW: 4600, ratedPowerW: 980,
      protocol: 'Wi-Fi (Gree+)', powerSupply: '220V AC',
    },
    purchaseUrl: 'https://item.jd.com/100010386677.html',
    priceCny: 2999,
  },
  {
    id: 'seed-philips-hue-ceiling',
    vendor: 'Philips',
    model: 'Hue White Ceiling 9290018',
    name: '飞利浦Hue吸顶灯',
    deviceType: 'light',
    capabilities: [
      'lighting-control', 'brightness-control', 'turn-on', 'turn-off', 'set-brightness',
    ],
    physics: { lightEffect: 0.8, effectRadiusM: 4 },
    specs: { protocol: 'Zigbee (Hue Bridge)', powerW: 32, lumens: 2400, colorTempK: 2700 },
    purchaseUrl: 'https://www.philips-hue.com/zh-cn',
    priceCny: 499,
  },
  {
    id: 'seed-xiaomi-rtcgq02lm',
    vendor: 'Xiaomi',
    model: 'RTCGQ02LM',
    name: '小米人体传感器2',
    deviceType: 'motion-sensor',
    capabilities: ['motion-detection'],
    physics: { detectionRangeM: 7, detectionAngleDeg: 130 },
    specs: { protocol: 'BLE', powerSupply: 'CR2450 battery', luxSensor: true },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=rtcgq02lm',
    priceCny: 59,
  },
  {
    id: 'seed-xiaomi-air-purifier-4pro',
    vendor: 'Xiaomi',
    model: 'AC-M15-SC',
    name: '米家空气净化器4Pro',
    deviceType: 'air-purifier',
    capabilities: [
      'air-purification', 'pm25-control', 'set-mode', 'set-fan-speed', 'turn-on', 'turn-off',
    ],
    physics: {
      maxPm25RatePerSec: 0.5, effectRadiusM: 5,
      stopBelowUgM3: 12, restartAboveUgM3: 20,
    },
    specs: { cadrM3h: 500, protocol: 'Wi-Fi (Mi Home)', powerW: 50, noiseDb: 33 },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=ac-m15-sc',
    priceCny: 1299,
  },
  {
    id: 'seed-aqara-zncldj11lm',
    vendor: 'Aqara',
    model: 'ZNCLDJ11LM',
    name: 'Aqara智能窗帘电机（开合帘版）',
    deviceType: 'curtain',
    capabilities: ['curtain-control', 'shade-control', 'set-curtain', 'turn-on', 'turn-off'],
    physics: {},
    specs: { protocol: 'Zigbee 3.0', torqueNm: 1.2, maxLoadKg: 50, powerSupply: '100-240V AC' },
    purchaseUrl: 'https://www.aqara.com/cn/product/curtain-controller',
    priceCny: 599,
  },
  {
    id: 'seed-xiaomi-jtyj-gd-03cw',
    vendor: 'Xiaomi',
    model: 'JTYJ-GD-03CW',
    name: '小米烟雾报警器',
    deviceType: 'smoke-sensor',
    capabilities: ['smoke-detection'],
    physics: {},
    specs: { protocol: 'Zigbee (via Honeywell)', powerSupply: 'CR123A battery', alarmDb: 80 },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=jtyj-gd-03cw',
    priceCny: 149,
  },
  {
    id: 'seed-honeywell-jt-q1f',
    vendor: 'Honeywell',
    model: 'JT-Q1F',
    name: '霍尼韦尔天然气报警器',
    deviceType: 'gas-sensor',
    capabilities: ['gas-detection'],
    physics: {},
    specs: { protocol: 'Zigbee (Mi Home edition)', gas: 'methane (CH4)', powerSupply: '220V AC' },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=gas-detector',
    priceCny: 199,
  },
  {
    id: 'seed-xiaomi-zncz04lm',
    vendor: 'Xiaomi',
    model: 'ZNCZ04LM',
    name: '米家智能插座2（蓝牙网关版）',
    deviceType: 'smart-plug',
    capabilities: ['power-control', 'turn-on', 'turn-off'],
    physics: { energyEffect: -0.5, effectRadiusM: 5 },
    specs: { protocol: 'BLE / BLE Mesh gateway', maxLoadW: 2500, metering: true },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=zncz04lm',
    priceCny: 49,
  },
  {
    id: 'seed-gree-kfr-26gw',
    vendor: 'Gree',
    model: 'KFR-26GW',
    name: '格力空调（大1匹）',
    deviceType: 'hvac',
    capabilities: [
      'temperature-control', 'cooling', 'set-temperature', 'set-mode', 'turn-on', 'turn-off',
    ],
    physics: { powerW: 3000, effectRadiusM: 4, hysteresisC: 0.5 },
    specs: {
      coolingCapacityW: 2600, ratedPowerW: 730,
      protocol: 'Wi-Fi (Gree+)', powerSupply: '220V AC',
    },
    purchaseUrl: 'https://item.jd.com/100007763113.html',
    priceCny: 2399,
  },
  {
    id: 'seed-xiaomi-mjjsq04dy',
    vendor: 'Xiaomi',
    model: 'MJJSQ04DY',
    name: '米家加湿器2',
    deviceType: 'humidifier',
    capabilities: ['humidity-control', 'set-mode', 'turn-on', 'turn-off'],
    physics: { ratePerSec: 0.3, effectRadiusM: 3, hysteresisPct: 2 },
    specs: { tankL: 4, humidificationMlH: 300, protocol: 'Wi-Fi (Mi Home)', powerW: 25 },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=mjjsq04dy',
    priceCny: 99,
  },
  {
    id: 'seed-yeelight-yldp13yl',
    vendor: 'Yeelight',
    model: 'YLDP13YL',
    name: 'Yeelight智能灯泡（彩光版）',
    deviceType: 'light',
    capabilities: ['lighting-control', 'turn-on', 'turn-off', 'set-brightness'],
    physics: { lightEffect: 0.8, effectRadiusM: 4 },
    specs: { protocol: 'Wi-Fi', powerW: 8.5, lumens: 800, colorTempK: '1700-6500' },
    purchaseUrl: 'https://www.yeelight.com/product/yldp13yl',
    priceCny: 99,
  },
  {
    id: 'seed-qingping-cgs1',
    vendor: 'Qingping',
    model: 'CGS1',
    name: '青萍空气检测仪（CO2版）',
    deviceType: 'co2-sensor',
    capabilities: ['co2-monitoring', 'air-quality-monitoring'],
    physics: {},
    specs: {
      protocol: 'Wi-Fi + BLE', co2Sensor: 'Senseair S8 NDIR', co2RangePpm: '400-5000',
      powerSupply: 'USB-C',
    },
    purchaseUrl: 'https://www.qingping.co/air-monitor',
    priceCny: 599,
  },
  {
    id: 'seed-benq-screenbar',
    vendor: 'BenQ',
    model: 'ScreenBar',
    name: '明基ScreenBar屏幕挂灯',
    deviceType: 'light',
    capabilities: ['lighting-control', 'turn-on', 'turn-off', 'set-brightness'],
    physics: { lightEffect: 0.8, effectRadiusM: 4 },
    specs: { powerSupply: 'USB 5V', powerW: 5, colorTempK: '2700-6500', asymmetricOptics: true },
    purchaseUrl: 'https://www.benq.com.cn/product/lighting/screenbar',
    priceCny: 899,
  },
  {
    id: 'seed-xiaomi-zncz05lm',
    vendor: 'Xiaomi',
    model: 'ZNCZ05LM',
    name: '米家智能插座3',
    deviceType: 'smart-plug',
    capabilities: ['power-control', 'turn-on', 'turn-off'],
    physics: { energyEffect: -0.5, effectRadiusM: 5 },
    specs: { protocol: 'BLE Mesh', maxLoadW: 2500, metering: true },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=zncz05lm',
    priceCny: 59,
  },
  {
    id: 'seed-qingping-cgllc',
    vendor: 'Qingping',
    model: 'CGPR1 Light',
    name: '青萍光照传感器',
    deviceType: 'light-sensor',
    capabilities: ['light-monitoring', 'illuminance-monitoring'],
    physics: { lightNoiseLux: 10 },
    specs: { protocol: 'BLE', rangeLux: '0-83000', powerSupply: 'CR2450 battery' },
    purchaseUrl: 'https://www.qingping.co/light-sensor',
    priceCny: 79,
  },

  // -----------------------------------------------------------------------
  // Care / wearable additions (Wave-1b content ecosystem, R4 小周 F-03)
  // deviceType values are template types the simulation understands
  // (wearable / emergency-button / motion-sensor); capability strings follow
  // those templates plus the care vocabulary users actually bind agents to.
  // -----------------------------------------------------------------------
  {
    id: 'seed-xiaomi-watch-s3',
    vendor: 'Xiaomi',
    model: 'Watch S3',
    name: '小米手表S3（心率/血氧）',
    deviceType: 'wearable',
    capabilities: ['heart-monitor', 'spo2-monitoring', 'measure-steps', 'track-location', 'receive-alerts'],
    physics: {},
    specs: { protocol: 'BLE 5.2', battery: '486mAh', display: '1.43" AMOLED', waterproof: '5ATM' },
    purchaseUrl: 'https://www.mi.com/shop/detail?product_id=watch-s3',
    priceCny: 799,
  },
  {
    id: 'seed-huawei-watch-d',
    vendor: 'Huawei',
    model: 'WATCH D',
    name: '华为WATCH D（跌倒检测/血压）',
    deviceType: 'wearable',
    capabilities: ['fall-detection', 'detect-movement', 'heart-monitor', 'receive-alerts'],
    physics: {},
    specs: { protocol: 'BLE 5.1', battery: '451mAh', sensors: 'PPG/加速度计/气压计', waterproof: 'IP68' },
    purchaseUrl: 'https://consumer.huawei.com/cn/wearables/watch-d/',
    priceCny: 2488,
  },
  // R78-D（R77 F2）：客流计数器类目——此前目录没有任何设备能支撑
  // crowd-monitoring/people-counting（R71/R77 两轮 persona 的 top 未支撑
  // 能力）。真实产品：Milesight VS121（AI 工位/客流传感器）、海康威视
  // 客流统计相机。
  // R80（FW3 需求榜驱动）：camera-monitoring 上榜（R79 保卫处 persona 搜
  // 「摄像头」0 行）——目录扩充第一次由遥测数据驱动而非探针撞见。
  {
    id: 'seed-hikvision-ds-2cd3t46',
    vendor: 'Hikvision',
    model: 'DS-2CD3T46(WD)-I3',
    name: '海康威视周界警戒摄像机（300万 PoE）',
    deviceType: 'camera',
    capabilities: ['camera-monitoring', 'motion-detection', 'night-vision', 'event-recording'],
    physics: { detectionRangeM: 30, detectionAngleDeg: 90 },
    specs: { protocol: 'PoE / ONVIF / GB28181', resolution: '2304×1296', ir: '30m 红外' },
    purchaseUrl: 'https://www.hikvision.com/en/products/Network-Camera/',
    priceCny: 769,
  },
  {
    id: 'seed-ezviz-h8c',
    vendor: 'EZVIZ',
    model: 'H8c 4MP',
    name: '萤石云台摄像机 H8c（360° 全向）',
    deviceType: 'camera',
    capabilities: ['camera-monitoring', 'motion-detection', 'people-counting', 'two-way-audio'],
    physics: { detectionRangeM: 10, detectionAngleDeg: 355 },
    specs: { protocol: 'Wi-Fi / 萤石云', resolution: '2560×1440', ptz: '水平 355°' },
    purchaseUrl: 'https://www.ezvizlife.com/',
    priceCny: 329,
  },
  // R78-D 客流类目保持（这是上一轮遥测驱动的先例）
  {
    id: 'seed-milesight-vs121',
    vendor: 'Milesight',
    model: 'VS121',
    name: 'Milesight VS121 AI 客流传感器',
    deviceType: 'people-counter',
    capabilities: ['people-counting', 'occupancy-monitoring', 'crowd-monitoring'],
    physics: { detectionRangeM: 8, detectionAngleDeg: 100 },
    specs: { protocol: 'Wi-Fi / LoRaWAN', technology: 'millimeter-wave + AI', mounting: '顶装' },
    purchaseUrl: 'https://www.milesight.com/iot/product/ai-tof-smart-sensor-vs121',
    priceCny: 899,
  },
  {
    id: 'seed-hikvision-ds-2cd6462',
    vendor: 'Hikvision',
    model: 'DS-2CD6462G0',
    name: '海康威视客流统计相机（双目）',
    deviceType: 'people-counter',
    capabilities: ['people-counting', 'crowd-monitoring', 'occupancy-monitoring'],
    physics: { detectionRangeM: 10, detectionAngleDeg: 90 },
    specs: { protocol: 'PoE / ONVIF', technology: '双目立体视觉', line: 'iDS-2CD6462 系列' },
    purchaseUrl: 'https://www.hikvision.com/en/products/People-Counting-Camera/',
    priceCny: 2399,
  },
  {
    id: 'seed-aqara-fp2',
    vendor: 'Aqara',
    model: 'FP2 Presence Sensor',
    name: 'Aqara人体存在传感器FP2（离床/跌倒监测）',
    deviceType: 'motion-sensor',
    capabilities: ['motion-detection', 'occupancy-monitoring', 'fall-detection'],
    physics: { detectionRangeM: 8, detectionAngleDeg: 120 },
    specs: { protocol: 'Wi-Fi (Matter)', technology: 'mmWave radar 60GHz', zones: 'up to 30' },
    purchaseUrl: 'https://www.aqara.com/en/product/presence-sensor-fp2/',
    priceCny: 549,
  },
  {
    id: 'seed-sonoff-snzb01p',
    vendor: 'SONOFF',
    model: 'SNZB-01P',
    name: 'SONOFF无线按钮（床头呼叫器）',
    deviceType: 'emergency-button',
    capabilities: ['get-state', 'get-press-count', 'reset'],
    physics: {},
    specs: { protocol: 'Zigbee 3.0', powerSupply: 'CR2477 battery', actions: 'single/double/long press' },
    purchaseUrl: 'https://sonoff.tech/product/snzb-01p/',
    priceCny: 49,
  },
  {
    id: 'seed-contec-cms50d',
    vendor: 'Contec',
    model: 'CMS50D',
    name: '康泰指夹式血氧仪CMS50D',
    deviceType: 'wearable',
    capabilities: ['spo2-monitoring', 'heart-monitor'],
    physics: {},
    specs: { protocol: 'BLE 4.0', powerSupply: '2×AAA', accuracy: 'SpO2 ±2% / PR ±2bpm' },
    purchaseUrl: 'https://contecmed.en.alibaba.com/product/CMS50D.html',
    priceCny: 129,
  },

  // -----------------------------------------------------------------------
  // City-relevant additions (for the smart-city templates, §11.4 geo layer)
  // -----------------------------------------------------------------------
  {
    // The simulation has no 'camera' type (no template, no physics effect);
    // mapped to the closest supported type — a camera's sim-observable
    // behavior is motion/presence detection.
    id: 'seed-hikvision-ds2cd3t46',
    vendor: 'Hikvision',
    model: 'DS-2CD3T46WD-I3',
    name: '海康威视400万网络摄像机',
    deviceType: 'motion-sensor',
    capabilities: ['motion-detection'],
    physics: { detectionRangeM: 30, fieldOfViewDeg: 104 },
    specs: {
      protocol: 'PoE / ONVIF / RTSP', resolutionMp: 4, irRangeM: 30,
      note: "catalog type is 'motion-sensor': simulation has no camera type",
    },
    purchaseUrl: 'https://www.hikvision.com/cn/products/IP-Products/Network-Cameras/',
    priceCny: 450,
  },
  {
    id: 'seed-wasion-ddzy285',
    vendor: 'Wasion',
    model: 'DDZY285',
    name: '威胜单相智能电表',
    deviceType: 'energy-meter',
    capabilities: ['energy-monitoring', 'power-monitoring'],
    physics: {},
    specs: {
      protocol: 'RS-485 / NB-IoT', accuracyClass: '1级', voltage: '220V', currentA: '5(60)',
    },
    purchaseUrl: 'https://www.wasion.com/product/single-phase-smart-meter',
    priceCny: 350,
  },
  {
    id: 'seed-sailhero-xhaqms3000',
    vendor: 'Sailhero',
    model: 'XHAQMS-3000',
    name: '先河网格化空气质量监测站',
    deviceType: 'air-quality-sensor',
    capabilities: ['air-quality-monitoring', 'pm25-monitoring'],
    physics: {},
    specs: {
      protocol: '4G / RS-485', measures: 'PM2.5, PM10, SO2, NO2, CO, O3',
      powerSupply: 'mains / solar',
    },
    purchaseUrl: 'https://www.sailhero.com/product/xhaqms-3000',
    priceCny: 45000,
  },
  {
    id: 'seed-sansi-smart-pole-light',
    vendor: 'Sansi',
    model: 'LED Street Light 90W Smart',
    name: '三思智慧路灯（单灯控制）',
    deviceType: 'light',
    capabilities: ['lighting-control', 'brightness-control', 'turn-on', 'turn-off', 'set-brightness'],
    physics: { lightEffect: 0.8, effectRadiusM: 4 },
    specs: {
      protocol: 'PLC / NB-IoT (单灯控制器)', powerW: 90, lumens: 11700, colorTempK: 4000,
    },
    purchaseUrl: 'https://www.sansitech.com/smart-street-light',
    priceCny: 3200,
  },
  {
    // No 'traffic-detector' type exists in the simulation; mapped to the
    // closest supported type — vehicle passage is reported as motion events.
    id: 'seed-hikvision-dtvd-lt-radar',
    vendor: 'Hikvision',
    model: 'DTVD-LT Radar-Video',
    name: '海康威视雷视车流量检测器',
    deviceType: 'motion-sensor',
    capabilities: ['motion-detection'],
    physics: { detectionRangeM: 200, lanes: 4 },
    specs: {
      protocol: 'RS-485 / RJ45', radarGhz: 24, detects: 'vehicle count, speed, occupancy',
      note: "catalog type is 'motion-sensor': simulation has no traffic-detector type",
    },
    purchaseUrl: 'https://www.hikvision.com/cn/products/ITS/',
    priceCny: 8000,
  },

  // -----------------------------------------------------------------------
  // Municipal / industrial tier (schema v3) — real smart-city deployments
  //
  // City-infrastructure hardware from Chinese smart-city projects (路灯/杆,
  // 环境监测, 交通, 井盖, 应急广播…). `tier` is 'municipal' (city services)
  // or 'industrial' (metering / demand-response gear). Where the simulation
  // has no exact semantic type, the entry maps to the closest supported one
  // and `specs.note` records the stand-in mapping.
  // -----------------------------------------------------------------------
  {
    id: 'seed-fpi-aqms1000',
    vendor: 'FPI',
    model: 'AQMS-1000',
    name: '聚光科技FPI环境空气自动监测站',
    deviceType: 'air-quality-sensor',
    tier: 'municipal',
    capabilities: ['air-quality-monitoring', 'pm25-monitoring'],
    physics: {},
    specs: {
      protocol: '4G / 光纤 (HJ 212 环保数采协议)',
      measures: 'PM2.5, PM10, SO2, NO2, O3, CO (国标六参数)',
      method: 'β射线法(PM) + 紫外荧光(SO2) + 化学发光(NO2) + 紫外光度(O3) + 气体滤波相关红外(CO)',
      powerSupply: '220V AC (站房)',
      standard: 'HJ 653 / HJ 654 环境空气气态污染物连续自动监测',
    },
    purchaseUrl: 'https://www.fpi-inc.com/product/aqms-1000',
    priceCny: 350000,
  },
  {
    // 雷视一体车检器: no 'traffic-detector' type in the simulation; vehicle
    // passage is reported as motion events (same mapping as the DTVD-LT seed).
    id: 'seed-hikvision-ids-tce500',
    vendor: 'Hikvision',
    model: 'iDS-TCE500',
    name: '海康威视iDS-TCE500雷视一体车检器',
    deviceType: 'motion-sensor',
    tier: 'municipal',
    capabilities: ['motion-detection'],
    physics: { detectionRangeM: 200, lanes: 4 },
    specs: {
      protocol: 'RJ45 / RS-485',
      radarGhz: 77,
      detects: '车流量, 车速, 排队长度, 车道占有率, 事件检测',
      coverageM: '50-200',
      note: "catalog type is 'motion-sensor': simulation has no traffic-detector type",
    },
    purchaseUrl: 'https://www.hikvision.com/cn/products/ITS/',
    priceCny: 12000,
  },
  {
    id: 'seed-dahua-dh-itc',
    vendor: 'Dahua',
    model: 'DH-ITC',
    name: '大华DH-ITC雷达视频车检器',
    deviceType: 'motion-sensor',
    tier: 'municipal',
    capabilities: ['motion-detection'],
    physics: { detectionRangeM: 150, lanes: 4 },
    specs: {
      protocol: 'RJ45 / RS-485',
      detects: '车流量, 车速, 车型, 排队长度',
      installation: '路口电警杆侧装',
      note: "catalog type is 'motion-sensor': simulation has no traffic-detector type",
    },
    purchaseUrl: 'https://www.dahuatech.com/product/traffic',
    priceCny: 9000,
  },
  {
    // 交通信号机: no 'signal-controller' type; phase switching is the closest
    // to a smart plug's on/off power control actuation.
    id: 'seed-hisense-hsc100',
    vendor: 'Hisense',
    model: 'HSC-100',
    name: '海信HSC-100交通信号机',
    deviceType: 'smart-plug',
    tier: 'municipal',
    capabilities: ['power-control', 'turn-on', 'turn-off', 'signal-control'],
    physics: { energyEffect: -0.5, effectRadiusM: 5 },
    specs: {
      protocol: 'NTCIP / GB 25280 联网通信, 光纤/4G 上联',
      phases: 16,
      detectInputs: '线圈/地磁/视频 车检器接入',
      modes: '定周期, 感应, 自适应, 绿波协调, 手动黄闪',
      powerSupply: '220V AC',
      note: "catalog type is 'smart-plug': closest sim actuation for signal phase switching",
    },
    purchaseUrl: 'https://www.hisense-transtech.com/product/hsc100',
    priceCny: 60000,
  },
  {
    id: 'seed-wasion-dtsd342',
    vendor: 'Wasion',
    model: 'DTSD342',
    name: '威胜DTSD342三相智能电表',
    deviceType: 'energy-meter',
    tier: 'industrial',
    capabilities: ['energy-monitoring', 'power-monitoring'],
    physics: {},
    specs: {
      protocol: 'RS-485 (Modbus-RTU / DL/T 645-2007)',
      accuracyClass: '0.5S级',
      voltage: '3×220/380V',
      currentA: '3×1.5(6)',
      measures: '分相电压/电流/功率/功率因数, 四象限电能, 需量, 谐波',
    },
    purchaseUrl: 'https://www.wasion.com/product/three-phase-smart-meter',
    priceCny: 1200,
  },
  {
    id: 'seed-shunzhou-sz10-nb',
    vendor: 'Shunzhou',
    model: 'SZ10-NB',
    name: '顺舟智能SZ10-NB单灯控制器(NB-IoT)',
    deviceType: 'light',
    tier: 'municipal',
    capabilities: ['lighting-control', 'brightness-control', 'turn-on', 'turn-off', 'set-brightness'],
    physics: { lightEffect: 0.8, effectRadiusM: 4 },
    specs: {
      protocol: 'NB-IoT (电信/移动/联通), PWM/0-10V 调光输出',
      metering: '电压/电流/功率/漏电流监测',
      maxLoadW: 400,
      powerSupply: '85-265V AC (灯杆内安装)',
    },
    purchaseUrl: 'https://www.shuncom.com/product/sz10-nb',
    priceCny: 260,
  },
  {
    // 智慧灯杆: multi-function pole (lighting + env sensing + camera + PA);
    // the simulation models its primary actuation — the light.
    id: 'seed-smart-pole-integrated',
    vendor: 'Generic',
    model: 'Smart Pole Integrated 5-in-1',
    name: '智慧灯杆（照明/环境监测/视频/广播一体杆）',
    deviceType: 'light',
    tier: 'municipal',
    capabilities: ['lighting-control', 'turn-on', 'turn-off', 'set-brightness'],
    physics: { lightEffect: 0.8, effectRadiusM: 4 },
    specs: {
      protocol: '边缘网关汇聚 (RS-485/以太网), 平台侧 MQTT/HTTP',
      payload: 'LED照明(可调光), 空气六参微站, 球机, IP音柱, 一键报警, 信息屏',
      poleHeightM: 10,
      powerSupply: '220V AC, 杆内配电',
      note: "catalog type is 'light': simulation models the pole's lighting actuation",
    },
    purchaseUrl: null,
    priceCny: 45000,
  },
  {
    // 雷达水位计: no 'water-level-sensor' type; the closest generic
    // environmental sensor type carries its readings.
    id: 'seed-radar-water-level',
    vendor: 'Generic',
    model: 'Radar Level Meter 26GHz (窨井/河道)',
    name: '雷达水位计（窨井/河道监测）',
    deviceType: 'temp-humidity-sensor',
    tier: 'municipal',
    capabilities: ['water-level-monitoring', 'temperature-monitoring'],
    physics: {},
    specs: {
      protocol: 'NB-IoT / 4G, RS-485 (Modbus-RTU)',
      radarGhz: 26,
      rangeM: '0-30',
      accuracyMm: 3,
      powerSupply: '锂电池 (3年) / 太阳能',
      rating: 'IP68',
      note: "catalog type is 'temp-humidity-sensor': closest generic environmental sensor in the simulation",
    },
    purchaseUrl: null,
    priceCny: 3500,
  },
  {
    id: 'seed-hikvision-ds2dc',
    vendor: 'Hikvision',
    model: 'DS-2DC',
    name: '海康威视DS-2DC智能球机',
    deviceType: 'motion-sensor',
    tier: 'municipal',
    capabilities: ['motion-detection'],
    physics: { detectionRangeM: 150, fieldOfViewDeg: 360 },
    specs: {
      protocol: 'GB/T 28181 国标联网, ONVIF, RTSP, PoE+',
      resolutionMp: 4,
      opticalZoom: 32,
      ptz: '360°连续旋转, -20°~90° 俯仰',
      rating: 'IP66',
      note: "catalog type is 'motion-sensor': simulation has no camera type",
    },
    purchaseUrl: 'https://www.hikvision.com/cn/products/IP-Products/PTZ-Cameras/',
    priceCny: 4500,
  },
  {
    // 直流充电桩: no 'ev-charger' type; the sim-visible facet is its
    // metering (per-session energy/power), like an energy meter.
    id: 'seed-teld-tcdz120',
    vendor: 'TELD',
    model: 'TCDZ-120',
    name: '特来电TCDZ-120直流充电桩',
    deviceType: 'energy-meter',
    tier: 'municipal',
    capabilities: ['energy-monitoring', 'power-monitoring', 'charging-service'],
    physics: {},
    specs: {
      protocol: 'OCPP 1.6J (平台), GB/T 27930 (车端CAN)',
      outputKw: 120,
      outputV: '200-750 DC',
      connectors: '双枪 (GB/T 20234.3)',
      metering: '双枪分路计量, 峰谷计费',
      rating: 'IP54 户外落地式',
      note: "catalog type is 'energy-meter': simulation has no ev-charger type",
    },
    purchaseUrl: 'https://www.teld.cn/product/tcdz-120',
    priceCny: 65000,
  },
  {
    id: 'seed-nbiot-manhole-cover',
    vendor: 'Generic',
    model: 'NB-IoT Manhole Sensor',
    name: 'NB-IoT智能井盖传感器',
    deviceType: 'motion-sensor',
    tier: 'municipal',
    capabilities: ['motion-detection', 'tilt-alarm'],
    physics: {},
    specs: {
      protocol: 'NB-IoT',
      sensor: '三轴加速度计 (倾角/移位/异动告警)',
      alarm: '开盖, 倾斜>15°, 位移, 水浸(选配)',
      powerSupply: 'ER18505 锂亚电池 (5年)',
      rating: 'IP68',
      note: "catalog type is 'motion-sensor': cover movement/tilt maps to motion events",
    },
    purchaseUrl: null,
    priceCny: 280,
  },
  {
    // 应急广播音柱: no 'speaker/PA' actuation type; on/off + power is the
    // smart-plug-shaped control surface.
    id: 'seed-emergency-pa-column',
    vendor: 'Generic',
    model: 'IP PA Column 60W',
    name: '应急广播音柱（IP网络）',
    deviceType: 'smart-plug',
    tier: 'municipal',
    capabilities: ['power-control', 'turn-on', 'turn-off', 'emergency-broadcast'],
    physics: { energyEffect: -0.5, effectRadiusM: 5 },
    specs: {
      protocol: 'IP/SIP 网络广播, 4G 备份链路',
      powerW: 60,
      coverageM: '30-50',
      trigger: '应急平台远程唤醒, 本地MP3/话筒插播',
      rating: 'IP65 室外音柱',
      note: "catalog type is 'smart-plug': closest sim actuation for broadcast on/off",
    },
    purchaseUrl: null,
    priceCny: 1500,
  },
  {
    id: 'seed-sgcc-load-terminal',
    vendor: 'State Grid',
    model: '负控终端/负荷聚合网关',
    name: '国网负控终端（需求响应负荷聚合网关）',
    deviceType: 'energy-meter',
    tier: 'industrial',
    capabilities: ['energy-monitoring', 'power-monitoring', 'demand-response'],
    physics: {},
    specs: {
      protocol: 'Q/GDW 1374.1 专变采集终端, 4G/230MHz 专网, RS-485 (DL/T 645)',
      function: '负荷监测, 遥控分合闸, 需求响应负荷聚合, 有序用电',
      controlLoops: 4,
      powerSupply: '3×220/380V AC',
      standard: 'Q/GDW 1375.1 电力用户用电信息采集系统',
    },
    purchaseUrl: null,
    priceCny: 5000,
  },
];

/**
 * Insert every seed model that is not already present. Returns the number of
 * newly inserted rows (0 on every boot after the first).
 */
export function seedCatalogModels(
  catalog: CatalogStore,
  createdBy: string | null,
  log?: SeedLogger,
): number {
  let inserted = 0;
  for (const model of CATALOG_SEED_MODELS) {
    if (catalog.get(model.id) !== undefined) continue;
    catalog.create(
      { ...model, source: 'seed', status: 'active', createdBy },
      { ignoreExisting: true },
    );
    inserted += 1;
  }
  if (inserted > 0) {
    log?.info({ inserted, total: CATALOG_SEED_MODELS.length }, 'Seeded device-model catalog');
  }
  return inserted;
}
