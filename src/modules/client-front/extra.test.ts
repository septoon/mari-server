import assert from 'node:assert/strict';
import test from 'node:test';

import { validateClientFrontExtra } from './extra';

test('validateClientFrontExtra keeps homePage content inside siteContent', () => {
  const extra = validateClientFrontExtra({
    siteContent: {
      homePage: {
        hero: {
          eyebrow: 'Салон красоты MARI',
          title: 'Новый заголовок',
          description: 'Новый текст для главной страницы',
          primaryCtaLabel: 'Записаться',
          secondaryCtaLabel: 'Услуги',
          visualLabel: 'MARI',
          visualTitle: 'Новый визуальный заголовок',
          visualSubtitle: 'Новый визуальный подзаголовок'
        },
        valuePillars: {
          eyebrow: 'Почему мы',
          title: 'Преимущества',
          description: 'Описание преимуществ',
          items: [
            {
              title: 'Пункт 1',
              text: 'Описание пункта 1'
            }
          ]
        },
        highlights: [
          {
            title: 'Карточка доверия',
            description: 'Описание карточки'
          }
        ]
      }
    }
  });

  assert.deepEqual(extra, {
    siteContent: {
      homePage: {
        hero: {
          eyebrow: 'Салон красоты MARI',
          title: 'Новый заголовок',
          description: 'Новый текст для главной страницы',
          primaryCtaLabel: 'Записаться',
          secondaryCtaLabel: 'Услуги',
          visualLabel: 'MARI',
          visualTitle: 'Новый визуальный заголовок',
          visualSubtitle: 'Новый визуальный подзаголовок'
        },
        valuePillars: {
          eyebrow: 'Почему мы',
          title: 'Преимущества',
          description: 'Описание преимуществ',
          items: [
            {
              title: 'Пункт 1',
              text: 'Описание пункта 1'
            }
          ]
        },
        highlights: [
          {
            title: 'Карточка доверия',
            description: 'Описание карточки'
          }
        ]
      }
    }
  });
});
