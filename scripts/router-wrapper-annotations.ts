import type { Plugin } from "vite";

/**
 * The pinned Router build omits PURE hints on forwardRef + displayName wrappers.
 * Annotate only those three package-local constructors, not arbitrary calls or
 * property access across application/vendor code. No library behavior is patched:
 * used wrappers still run; unused wrappers can be removed with their imports.
 */
export function routerWrapperAnnotations(): Plugin {
  return {
    name: "toki-router-wrapper-annotations",
    enforce: "pre",
    transform(code, id) {
      const result = annotateRouterWrappers(code, id);
      if (result !== undefined) return { code: result, map: null };
    },
  };
}

export function annotateRouterWrappers(code: string, id: string): string | undefined {
  if (
    !id.includes("/node_modules/") ||
    !id.endsWith("/react-router/dist/production/lib/dom/lib.js")
  )
    return;
  let result = code;
  for (const name of ["Link", "NavLink", "Form"]) {
    const start = `const ${name} = React$1.forwardRef(`;
    const end = `\n${name}.displayName = "${name}";`;
    if (!result.includes(start) || !result.includes(end))
      throw new Error("Pinned React Router wrappers changed; review tree-shaking before building.");
    // Keep displayName inside the same pure expression so no global
    // property-side-effect assumptions are needed for dead code removal.
    result = result
      .replace(
        start,
        `const ${name} = /* @__PURE__ */ (() => { const component = React$1.forwardRef(`,
      )
      .replace(end, `\ncomponent.displayName = "${name}"; return component; })();`);
  }
  return result;
}
