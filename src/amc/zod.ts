// The zod API the gateway uses, re-exported by name. Import it as `import * as z from '<path>/amc/zod'`, never
// `import { z } from 'zod'`: the `z` namespace object keeps every zod 4 module (locales, JSON Schema conversion) in
// the worker bundle, ~650 KB; named exports let the bundler drop what isn't called. Add a member here when a file
// needs one (tsc names it).
export {
  any,
  array,
  boolean,
  date,
  enum,
  instanceof,
  lazy,
  number,
  object,
  record,
  string,
  union,
} from 'zod';
