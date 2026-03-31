import { API } from 'homebridge';
import { HikVisionNVR } from './HikVisionNVR.js';

export const HIKVISION_PLATFORM_NAME = 'Hikvision-Local-Substream';
export const HIKVISION_PLUGIN_NAME = 'homebridge-hikvision-local-substream';

export default function main(api: API) {
  api.registerPlatform(
    HIKVISION_PLUGIN_NAME,
    HIKVISION_PLATFORM_NAME,
    HikVisionNVR,
  );
}
