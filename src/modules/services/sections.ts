export const DEFAULT_SERVICE_SECTIONS = [
  {
    id: 'f995b1e0-31c6-478a-8cc4-4cbe0c1f8551',
    name: 'Парикмахерские услуги',
    orderIndex: 10,
    categoryNames: [
      'Стрижки мужские',
      'Стрижки женские',
      'Окрашивание',
      'Уход',
      'Укладка',
      'Прическа'
    ]
  },
  {
    id: '711278eb-3db0-4b55-b3cb-8a7d7165870e',
    name: 'Ногтевой сервис',
    orderIndex: 20,
    categoryNames: [
      'Маникюр',
      'Педикюр',
      'Педикюр от подолога'
    ]
  },
  {
    id: '2ad1d37a-aad7-47ad-9756-af3020bd1d5f',
    name: 'Косметология',
    orderIndex: 30,
    categoryNames: [
      'Косметология',
      'Косметология - пилинг',
      'Косметология - Аппаратные процедуры',
      'Массаж лица'
    ]
  },
  {
    id: '5d87e7e6-df34-4d9c-b6f0-59d7a9f90588',
    name: 'Массаж тела',
    orderIndex: 40,
    categoryNames: [
      'Лечебный массаж',
      'Лимфодренажный массаж',
      'Антицеллюлитный массаж',
      'Аппаратный массаж'
    ]
  }
] as const;

const normalizeServiceSectionKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\s+/g, ' ');

const sectionByCategoryName = new Map(
  DEFAULT_SERVICE_SECTIONS.flatMap((section) =>
    section.categoryNames.map((categoryName) => [
      normalizeServiceSectionKey(categoryName),
      section
    ] as const)
  )
);

export const findDefaultServiceSectionByCategoryName = (categoryName: string | null | undefined) => {
  if (!categoryName) {
    return null;
  }

  return sectionByCategoryName.get(normalizeServiceSectionKey(categoryName)) ?? null;
};
