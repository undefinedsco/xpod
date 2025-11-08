import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import zh from '../locales/zh.json';

const resources = {
  en: { translation: en },
  zh: { translation: zh },
};

const fallbackLng = 'zh';
const browserLanguage =
  typeof window !== 'undefined' && typeof navigator !== 'undefined'
    ? navigator.language ?? navigator.languages?.[0]
    : undefined;
const initialLng =
  browserLanguage && browserLanguage.toLowerCase().startsWith('en') ? 'en' : 'zh';

void i18next
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLng,
    fallbackLng,
    interpolation: { escapeValue: false },
    defaultNS: 'translation',
  });

export default i18next;
