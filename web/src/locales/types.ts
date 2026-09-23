/** Same nested keys as the English file, every leaf a string. */
export type LocaleShape<T> = { [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]> }
