import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  annotateRouterWrappers,
  routerWrapperAnnotations,
} from "../../scripts/router-wrapper-annotations";

const id = "/repository/node_modules/react-router/dist/production/lib/dom/lib.js";
const names = ["Link", "NavLink", "Form"];
const fixture = names
  .map(
    (name) =>
      `const ${name} = React$1.forwardRef(function render() { throw new Error("must not render"); });\n${name}.displayName = "${name}";`,
  )
  .join("\n");
describe("scoped Router tree-shaking hints", () => {
  it("annotates the three pinned package wrappers, without changing any other code", () => {
    const source = readFileSync(
      new URL("./lib/dom/lib.js", import.meta.resolve("react-router")),
      "utf8",
    );
    const result = annotateRouterWrappers(source, id);
    expect(result?.match(/const component = React\$1.forwardRef/gu)).toHaveLength(3);
    expect(result).toContain('window.__reactRouterVersion = "8.3.0"');
    expect(result).toContain("export {");
  });
  it.each([
    "/repo/src/react-router/dist/production/lib/dom/lib.js",
    "/repo/node_modules/other/dist/production/lib/dom/lib.js",
    "/repo/node_modules/react-router/dist/development/lib/dom/lib.js",
  ])("never transforms unrelated or development modules: %s", (path) => {
    expect(annotateRouterWrappers(fixture, path)).toBeUndefined();
  });
  it("fails closed if a future package changes the reviewed wrapper pattern", () => {
    expect(() =>
      annotateRouterWrappers(fixture.replace('Link.displayName = "Link";', ""), id),
    ).toThrow("Pinned React Router wrappers changed");
  });
  it("preserves the objects, display names, constructor calls and lazy render behavior", () => {
    const forwardRef = vi.fn(() => ({}));
    const result = runInNewContext(`${annotateRouterWrappers(fixture, id)}\n[Link,NavLink,Form]`, {
      React$1: { forwardRef },
    }) as { displayName: string }[];
    expect(result.map((item) => item.displayName)).toEqual(names);
    expect(forwardRef).toHaveBeenCalledTimes(3);
    expect(routerWrapperAnnotations()).toMatchObject({
      name: "toki-router-wrapper-annotations",
      enforce: "pre",
    });
  });
});
