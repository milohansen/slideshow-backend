import { argbFromHex, hexFromArgb, themeFromSourceColor } from "@material/material-color-utilities";
import { Hono } from "hono";
import { getBlob } from "../db/helpers-firestore.ts";

const colors = new Hono();

colors.get("/scheme/:imageId", async (c) => {
  const { imageId } = c.req.param();

  const blob = await getBlob(imageId);

  const colors: string[] = blob?.color_palette ? JSON.parse(blob.color_palette) : [];

  if (colors.length < 3) {
    return c.json({ palette: null });
  }

  const sourceColorArgb = argbFromHex(colors[0]);

  // const primaryPalette = TonalPalette.fromHct(Hct.fromInt(sourceColorArgb));
  // const secondaryPalette = TonalPalette.fromHct(Hct.fromInt(argbFromHex(colors[1])));
  // const tertiaryPalette = TonalPalette.fromHct(Hct.fromInt(argbFromHex(colors[2])));

  const theme = themeFromSourceColor(sourceColorArgb);

  const schemeJson = theme.schemes.light.toJSON();
  const light: Record<string, string> = {};
  for (const key in schemeJson) {
    light[key] = hexFromArgb(schemeJson[key]);
  }

  return c.json(light);
});

colors.get("/maketheme/:color", async (c) => {
  const { color } = c.req.param();

  const sourceColorArgb = argbFromHex(color);

  // const primaryPalette = TonalPalette.fromHct(Hct.fromInt(sourceColorArgb));
  // const secondaryPalette = TonalPalette.fromHct(Hct.fromInt(argbFromHex(colors[1])));
  // const tertiaryPalette = TonalPalette.fromHct(Hct.fromInt(argbFromHex(colors[2])));

  const theme = themeFromSourceColor(sourceColorArgb);

  const schemeJson = theme.schemes.light.toJSON();
  const light: Record<string, string> = {};
  const argbArr: number[] = [];
  const hexArr: string[] = [];
  for (const key in schemeJson) {
    const hex = hexFromArgb(schemeJson[key]);
    hexArr.push(hex);
    // light[key] = hexFromArgb(schemeJson[key]);
    light[keyMap[key as keyof typeof keyMap]] = hex;
    argbArr.push(schemeJson[key]);
  }

  return c.json(hexArr);
  // return c.body(encode(argbArr));
  // return c.body(encode(light));
});

const keyMap = {
  primary: "p",
  onPrimary: "op",
  primaryContainer: "pc",
  onPrimaryContainer: "opc",

  secondary: "s",
  onSecondary: "os",
  secondaryContainer: "sc",
  onSecondaryContainer: "osc",

  tertiary: "t",
  onTertiary: "ot",
  tertiaryContainer: "tc",
  onTertiaryContainer: "otc",

  error: "e",
  onError: "oe",
  errorContainer: "ec",
  onErrorContainer: "oec",

  background: "bg",
  onBackground: "obg",

  surface: "sfc",
  onSurface: "osfc",
  surfaceVariant: "sfcv",
  onSurfaceVariant: "osfcv",

  outline: "ol",
  outlineVariant: "olv",
  shadow: "sh",
  scrim: "scr",
  inverseSurface: "isfc",
  inverseOnSurface: "iosfc",
  inversePrimary: "ipr",
} as const;

export default colors;
