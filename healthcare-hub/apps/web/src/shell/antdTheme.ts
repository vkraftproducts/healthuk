import { theme, type ThemeConfig } from 'antd';
import type { ThemeMode } from './theme.js';

/** Healthcare Hub UK v36 tokens for Ant Design ConfigProvider (matches docs/design HTML). */
export function hubTheme(mode: ThemeMode): ThemeConfig {
  const dark = mode === 'dark';
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? '#8cbcf0' : '#1667d9',
      colorInfo: dark ? '#8cbcf0' : '#1667d9',
      colorLink: dark ? '#8cbcf0' : '#1667d9',
      colorBgBase: dark ? '#0a1220' : '#f5f5f5',
      colorBgContainer: dark ? '#141414' : '#ffffff',
      colorBgLayout: dark ? '#0a1220' : '#f5f5f5',
      colorText: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.88)',
      colorTextSecondary: dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)',
      colorBorder: dark ? '#424242' : '#d9d9d9',
      colorBorderSecondary: dark ? '#303030' : '#f0f0f0',
      borderRadius: 6,
      fontFamily:
        "'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
      fontSize: 14,
      controlHeight: 32,
    },
    components: {
      Layout: {
        siderBg: dark ? '#141414' : '#ffffff',
        headerBg: dark ? '#141414' : '#ffffff',
        bodyBg: dark ? '#0a1220' : '#f5f5f5',
        triggerBg: dark ? '#1f1f1f' : '#ffffff',
        lightSiderBg: '#ffffff',
        lightTriggerBg: '#ffffff',
      },
      Menu: {
        itemBorderRadius: 6,
        itemHeight: 40,
        iconSize: 16,
        darkItemBg: '#141414',
        darkSubMenuItemBg: '#141414',
        darkItemSelectedBg: 'rgba(22,103,217,0.2)',
        darkItemHoverBg: 'rgba(255,255,255,0.06)',
        itemSelectedBg: '#e6f4ff',
        itemSelectedColor: '#1667d9',
        itemHoverBg: 'rgba(0,0,0,0.04)',
      },
      Table: {
        headerBg: dark ? '#1f1f1f' : '#fafafa',
        headerColor: dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)',
      },
      Card: {
        paddingLG: 16,
        borderRadiusLG: 8,
      },
      Statistic: {
        titleFontSize: 14,
        contentFontSize: 24,
      },
    },
  };
}
