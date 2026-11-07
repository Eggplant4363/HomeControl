/* 中控屏配置 —— 目前跑模拟数据，拿到 HA 地址和令牌后把 mock 改成 false 即可 */
window.PANEL_CONFIG = {
  title: '我的家',
  mock: true,
  ha: {
    url: 'ws://homeassistant.local:8123/api/websocket',
    token: ''
  },
  defaultRoom: 'living',
  /* 上墙显示：空闲多久变暗、夜间时段、变暗程度（0-1，越大越黑） */
  /* 每天几点静默 reload 一次（释放 WebView 内存）；设 null 关闭 */
  reloadHour: 4,
  /* 实时画面（MJPEG）：按实体配一个流地址，没配就走快照。
     例：'camera.tp_ipc_mainstream': 'http://10.10.1.7:1984/api/stream.mjpeg?src=mainStream' */
  camStream: {},

  dim: {
    idleSec: 90,
    nightStart: 23,
    nightEnd: 7,
    nightIdleSec: 20,
    level: 0.88,
    nightLevel: 0.95,
    /* 夜间背光（0~1，只作用本窗口；退出调暗恢复系统亮度） */
    brightness: 0.35
  },
  /* 防烧屏：每隔一段时间把整个界面挪 1~2px（长时间常亮时，静态元素不会把像素烤出残影） */
  burnIn: {
    shiftEverySec: 300,
    maxShift: 2
  },
  /* 负一屏 · 音乐（右滑进入）
     kind: 'mock' 演示音源 | 'subsonic' 任何 Subsonic 兼容服务 | 'daoliyu' 道理鱼
     在平板上「设置 → 音乐」里填服务器地址和账号，会写到 /sdcard/HomeControl/music.json，
     优先级：music.json > localStorage > 这里的默认值。 */
  music: {
    kind: 'mock',
    baseUrl: '',
    user: '',
    pass: '',
    playlists: []
  },
  scenes: [
    { name: '回家', entity: 'scene.arrive', icon: 'home' },
    { name: '观影', entity: 'scene.movie', icon: 'play' },
    { name: '睡眠', entity: 'scene.sleep', icon: 'moon' },
    { name: '全关', entity: 'script.all_off', icon: 'power' }
  ],
  rooms: [
    {
      id: 'living', name: '客厅', icon: 'sofa',
      tiles: [
        { type: 'light', entity: 'light.living_main', name: '主灯' },
        { type: 'light', entity: 'light.living_strip', name: '灯带' },
        { type: 'switch', entity: 'switch.living_tv', name: '电视插座' },
        { type: 'climate', entity: 'climate.living_ac', name: '空调' },
        { type: 'camera', entity: 'camera.mock_cam', name: '客厅摄像头' },
        { type: 'cover', entity: 'cover.living_curtain', name: '窗帘' },
        { type: 'sensor', entity: 'sensor.living_temp', name: '温度' },
        { type: 'sensor', entity: 'sensor.living_humidity', name: '湿度' },
        { type: 'sensor', entity: 'binary_sensor.living_motion', name: '人体感应' }
      ]
    },
    {
      id: 'master', name: '主卧', icon: 'bed',
      tiles: [
        { type: 'light', entity: 'light.master_main', name: '主灯' },
        { type: 'light', entity: 'light.master_bedside', name: '床头灯' },
        { type: 'climate', entity: 'climate.master_ac', name: '空调' },
        { type: 'cover', entity: 'cover.master_curtain', name: '窗帘' },
        { type: 'sensor', entity: 'sensor.master_temp', name: '温度' },
        { type: 'sensor', entity: 'sensor.master_humidity', name: '湿度' },
        { type: 'switch', entity: 'switch.master_plug', name: '加湿器' }
      ]
    },
    {
      id: 'study', name: '书房', icon: 'desk',
      tiles: [
        { type: 'light', entity: 'light.study_main', name: '主灯' },
        { type: 'light', entity: 'light.study_desk', name: '台灯' },
        { type: 'switch', entity: 'switch.study_pc', name: '电脑插座' },
        { type: 'climate', entity: 'climate.study_ac', name: '空调' },
        { type: 'sensor', entity: 'sensor.study_temp', name: '温度' },
        { type: 'sensor', entity: 'sensor.study_humidity', name: '湿度' }
      ]
    },
    {
      id: 'kitchen', name: '厨房', icon: 'pot',
      tiles: [
        { type: 'light', entity: 'light.kitchen_main', name: '吊灯' },
        { type: 'switch', entity: 'switch.kitchen_fan', name: '排气扇' },
        { type: 'sensor', entity: 'sensor.kitchen_temp', name: '温度' },
        { type: 'sensor', entity: 'binary_sensor.kitchen_smoke', name: '烟雾' }
      ]
    },
    {
      id: 'bath', name: '卫生间', icon: 'shower',
      tiles: [
        { type: 'light', entity: 'light.bath_mirror', name: '镜前灯' },
        { type: 'switch', entity: 'switch.bath_heater', name: '浴霸' },
        { type: 'sensor', entity: 'sensor.bath_humidity', name: '湿度' }
      ]
    },
    {
      id: 'balcony', name: '阳台', icon: 'hanger',
      tiles: [
        { type: 'light', entity: 'light.balcony_light', name: '阳台灯' },
        { type: 'cover', entity: 'cover.balcony_rack', name: '晾衣架' },
        { type: 'switch', entity: 'switch.balcony_washer', name: '洗衣机' },
        { type: 'sensor', entity: 'sensor.balcony_temp', name: '温度' }
      ]
    }
  ]
};

/* ---------------- 模拟数据（mock: true 时使用） ---------------- */
window.MOCK_ENTITIES = {
  'camera.mock_cam': {
    entity_id: 'camera.mock_cam', state: 'idle',
    attributes: {
      friendly_name: '客厅摄像头',
      entity_picture: 'data:image/jpeg;base64,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'
    }
  },
  'weather.home': { state: 'partlycloudy', attributes: { friendly_name: '天气', temperature: 18, humidity: 62 } },

  /* 住户（顶栏头像 + 在家/离家）；改 state 为 not_home 即可看离家样式 */
  'person.mock_owner': {
    state: 'home',
    attributes: {
      friendly_name: '我',
      entity_picture: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 fill=%22%233c6ea8%22/%3E%3Ccircle cx=%2232%22 cy=%2223%22 r=%2211%22 fill=%22%23eaf2ff%22/%3E%3Cpath d=%22M11 64c0-12 9-21 21-21s21 9 21 21z%22 fill=%22%23eaf2ff%22/%3E%3C/svg%3E'
    }
  },

  'light.living_main': { state: 'on', attributes: { friendly_name: '客厅主灯', brightness: 204, color_temp: 300, min_mireds: 153, max_mireds: 500, supported_color_modes: ['hs', 'color_temp'], color_mode: 'hs', hs_color: [35, 62], rgb_color: [255, 176, 80] } },
  'light.living_strip': { state: 'off', attributes: { friendly_name: '客厅灯带', brightness: 255, supported_color_modes: ['rgbw'], color_mode: 'rgbw', rgb_color: [110, 231, 183] } },
  'switch.living_tv': { state: 'on', attributes: { friendly_name: '电视插座', power: 68 } },
  'climate.living_ac': { state: 'heat', attributes: { friendly_name: '客厅空调', current_temperature: 21.5, temperature: 24, current_humidity: 46, hvac_modes: ['off', 'cool', 'heat', 'fan_only', 'dry', 'auto'], fan_modes: ['auto', 'low', 'medium', 'high'], fan_mode: 'auto' } },
  'cover.living_curtain': { state: 'open', attributes: { friendly_name: '客厅窗帘', current_position: 60 } },
  'sensor.living_temp': { state: '23.4', attributes: { friendly_name: '客厅温度', unit_of_measurement: '°C', device_class: 'temperature' } },
  'sensor.living_humidity': { state: '52', attributes: { friendly_name: '客厅湿度', unit_of_measurement: '%', device_class: 'humidity' } },
  'binary_sensor.living_motion': { state: 'off', attributes: { friendly_name: '客厅人体', device_class: 'motion' } },

  'light.master_main': { state: 'off', attributes: { friendly_name: '主卧主灯', brightness: 255 } },
  'light.master_bedside': { state: 'on', attributes: { friendly_name: '床头灯', brightness: 90, color_temp: 420 } },
  'climate.master_ac': { state: 'off', attributes: { friendly_name: '主卧空调', current_temperature: 24.8, temperature: 26, hvac_modes: ['off', 'cool', 'heat', 'fan_only', 'dry', 'auto'], fan_modes: ['auto', 'low', 'medium', 'high'], fan_mode: 'low' } },
  'cover.master_curtain': { state: 'closed', attributes: { friendly_name: '主卧窗帘', current_position: 0 } },
  'sensor.master_temp': { state: '24.6', attributes: { friendly_name: '主卧温度', unit_of_measurement: '°C', device_class: 'temperature' } },
  'sensor.master_humidity': { state: '48', attributes: { friendly_name: '主卧湿度', unit_of_measurement: '%', device_class: 'humidity' } },
  'switch.master_plug': { state: 'off', attributes: { friendly_name: '加湿器', power: 0 } },

  'light.study_main': { state: 'off', attributes: { friendly_name: '书房主灯', brightness: 255 } },
  'light.study_desk': { state: 'on', attributes: { friendly_name: '台灯', brightness: 255, color_temp: 250 } },
  'switch.study_pc': { state: 'on', attributes: { friendly_name: '电脑插座', power: 122 } },
  'climate.study_ac': { state: 'cool', attributes: { friendly_name: '书房空调', current_temperature: 27.2, temperature: 26, hvac_modes: ['off', 'cool', 'heat', 'fan_only', 'dry', 'auto'], fan_modes: ['auto', 'low', 'medium', 'high'], fan_mode: 'high' } },
  'sensor.study_temp': { state: '27.1', attributes: { friendly_name: '书房温度', unit_of_measurement: '°C', device_class: 'temperature' } },
  'sensor.study_humidity': { state: '45', attributes: { friendly_name: '书房湿度', unit_of_measurement: '%', device_class: 'humidity' } },

  'light.kitchen_main': { state: 'off', attributes: { friendly_name: '厨房吊灯', brightness: 255 } },
  'switch.kitchen_fan': { state: 'off', attributes: { friendly_name: '排气扇', power: 0 } },
  'sensor.kitchen_temp': { state: '25.2', attributes: { friendly_name: '厨房温度', unit_of_measurement: '°C', device_class: 'temperature' } },
  'binary_sensor.kitchen_smoke': { state: 'off', attributes: { friendly_name: '烟雾报警', device_class: 'smoke' } },

  'light.bath_mirror': { state: 'off', attributes: { friendly_name: '镜前灯', brightness: 255 } },
  'switch.bath_heater': { state: 'off', attributes: { friendly_name: '浴霸', power: 0 } },
  'sensor.bath_humidity': { state: '68', attributes: { friendly_name: '卫生间湿度', unit_of_measurement: '%', device_class: 'humidity' } },

  'light.balcony_light': { state: 'off', attributes: { friendly_name: '阳台灯', brightness: 255 } },
  'cover.balcony_rack': { state: 'closed', attributes: { friendly_name: '晾衣架', current_position: 0 } },
  'switch.balcony_washer': { state: 'off', attributes: { friendly_name: '洗衣机', power: 0 } },
  'sensor.balcony_temp': { state: '19.8', attributes: { friendly_name: '阳台温度', unit_of_measurement: '°C', device_class: 'temperature' } },

  'scene.arrive': { state: 'unknown', attributes: { friendly_name: '回家' } },
  'scene.movie': { state: 'unknown', attributes: { friendly_name: '观影' } },
  'scene.sleep': { state: 'unknown', attributes: { friendly_name: '睡眠' } },
  'script.all_off': { state: 'off', attributes: { friendly_name: '全关' } }
};
