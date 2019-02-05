#!/usr/bin/env node
/* eslint-disable no-param-reassign */
const postcss = require('postcss-scss');
const { camelCase } = require('lodash');
const format = require('prettier-eslint');
const selectorToLiteral = require('./selector-to-literal');
const includeMedia = require('./include-media');

// TODO make CLI option
const FE_BRARY_PREFIX = '$fe-brary-';

function placeHolderToVar(str) {
  return camelCase(str.slice(1));
}

function isNestedInMixin(root, node) {
  let nestedInMixin = false;
  let parentNode = node.parent;
  do {
    if (parentNode !== root && parentNode.type === 'atrule' && parentNode.name === 'mixin') {
      nestedInMixin = true;
    }
    parentNode = parentNode.parent;
  } while (parentNode && parentNode !== root && !nestedInMixin);

  return nestedInMixin;
}

function isNestedInPseudo(root, node) {
  let nestedInPseudo = false;
  let parentNode = node.parent;
  do {
    if (parentNode !== root && parentNode.type === 'rule' && parentNode.selector.startsWith('&:')) {
      nestedInPseudo = true;
    }
    parentNode = parentNode.parent;
  } while (parentNode && parentNode !== root && !nestedInPseudo);

  return nestedInPseudo;
}

function handleSassVar(decl, root) {
  if (decl.value.startsWith(FE_BRARY_PREFIX)) {
    if (!root.usesFeBraryVars) {
      root.usesFeBraryVars = true;
    }

    const [, name] = decl.value.split(FE_BRARY_PREFIX);
    const [field, ...varNameSegs] = name.split('-');
    const varName = camelCase(varNameSegs.join('-'));
    return `\${vars.${field}.${varName}}`;
  }

  if (decl.value.startsWith('$')) {
    const varName = camelCase(decl.value.slice(1));

    if (isNestedInMixin(root, decl) || root.nodes.some(node => node.prop === decl.value)) {
      return `\${${varName}}`;
    }

    if (!root.usesCustomVars) {
      root.usesCustomVars = true;
    }

    return `\${customVars.${varName}}`;
  }

  return decl.value;
}

function handleSassVarUnescaped(value) {
  if (value.startsWith(FE_BRARY_PREFIX)) {
    const [, name] = value.split(FE_BRARY_PREFIX);
    const [field, ...varNameSegs] = name.split('-');
    const varName = camelCase(varNameSegs.join('-'));
    return `vars.${field}.${varName}`;
  }

  if (value.startsWith('$')) {
    const varName = camelCase(value.slice(1));
    return `customVars.${varName}`;
  }

  const isWrappedInQuotes = ['"', "'"].includes(value[0]);
  if (isWrappedInQuotes) {
    return value;
  }

  // wrap in string quotes, e.g 100px => '100px'
  return `'${value}'`;
}

function placeHolderToVarRef(params) {
  return `\${${placeHolderToVar(params)}};`;
}

function mixinParamsToFunc(str) {
  const [funcName, inputs] = str.split('(');
  return `${camelCase(funcName)}(${inputs.replace(/\$/g, '')}`;
}

const processRoot = (root) => {
  root.classes = new Map();
  root.usesFeBraryVars = false;
  // move all three below to global scope and use stringify
  root.walkAtRules('extend', (atRule) => {
    atRule.originalParams = atRule.params;
    atRule.params = placeHolderToVarRef(atRule.params);
  });

  root.walkAtRules('include', (atRule) => {
    // check for https://github.com/eduardoboucas/include-media
    if (atRule.nodes && atRule.nodes.length && atRule.params.trim().startsWith('media(')) {
      atRule.name = 'media';
      atRule.params = includeMedia(atRule.params);
      if (atRule.params.includes('vars.')) root.usesFeBraryVars = true;
      return;
    }

    const [funcName, inputs] = atRule.params.split('(');
    const inputsWithoutBraces = inputs.slice(0, -1);
    const args = inputsWithoutBraces.split(',').map(arg => handleSassVarUnescaped(arg.trim()));

    atRule.originalParams = atRule.params;
    atRule.params = `\${${camelCase(funcName.trim())} (${args.join(', ')})}`;
  });

  root.walkDecls((decl) => {
    if (decl.parent && decl.parent === root) {
      let isUsedInFile = false;
      // search all decl values for ref
      root.walkDecls((declSearch) => {
        if (declSearch === decl) return;
        if (
          declSearch.value
          && declSearch.value.includes(decl.prop)
          && declSearch.parent !== root
        ) {
          isUsedInFile = true;
        }
      });
      root.classes.set(decl.prop, {
        type: 'constVar',
        node: decl,
        isUsedInFile,
      });
      return;
    }

    decl.value = handleSassVar(decl, root);
  });

  // flattens nested rules
  root.walkRules(/^(\.|%)/, (rule) => {
    let selector;
    const isPlaceHolder = rule.selector[0] === '%';

    let isUsedInFile = false;
    if (isPlaceHolder) {
      selector = placeHolderToVar(rule.selector);
      // search to see if placeholder is used
      root.walkAtRules('extend', (atRule) => {
        // note atRule.params has already been modified
        if (atRule.originalParams === rule.selector) {
          isUsedInFile = true;
        }
      });
    } else {
      selector = selectorToLiteral(rule.selector);
    }

    if (isNestedInMixin(root, rule)) return;

    let contents = '';
    postcss.stringify(rule, (string, node, startOrEnd) => {
      if (node && node === rule && startOrEnd) return;

      if (node && node.type === 'rule' && startOrEnd === 'start' && isNestedInPseudo(root, node)) {
        contents += `\${${selectorToLiteral(node.selector)}}`;
        return;
      }

      // ignore nested classes
      if (node && node.type === 'rule' && node.selector.startsWith('.')) return;

      if (
        node
        && node.type === 'decl'
        && node.parent !== rule
        && node.parent.type === 'rule'
        && node.parent.selector.startsWith('.')
      ) return;

      if (node && ['extend', 'include'].includes(node.name)) {
        contents += `${node.params}\n`;
        return;
      }

      contents += string;
    });

    root.classes.set(selector, {
      type: isPlaceHolder ? 'placeholder' : 'class',
      isUsedInFile,
      contents,
      node: rule,
    });
  });

  root.walkAtRules('mixin', (atRule) => {
    const { params } = atRule;
    const selector = mixinParamsToFunc(params);

    let contents = '';
    postcss.stringify(atRule, (string, node, startOrEnd) => {
      // if node.type === decl skip when doing this above
      // stops first and last part entering the string e.g "@mixin ad-exact($width, $height) {"
      if (node && node === atRule && startOrEnd) return;

      contents += string;
    });

    let isUsedInFile = false;
    // search to see if mixin is used in file
    root.walkAtRules('include', (rule) => {
      if (rule.originalParams.split('(')[0] === params.split('(')[0]) {
        isUsedInFile = true;
      }
    });

    root.classes.set(selector, {
      type: 'mixin',
      contents,
      isUsedInFile,
      node: atRule,
    });
  });
};

module.exports = (cssString, filePath) => {
  const root = postcss.parse(cssString, { from: filePath });

  processRoot(root);
  let fileIsJustVarExports = true;

  const emotionExports = Array.from(root.classes.entries())
    .sort(([, { node: a }], [, { node: b }]) => a.source.start.line - b.source.start.line)
    .reduce((acc, [name, {
      contents, type, node, isUsedInFile,
    }]) => {
      if (type !== 'constVar') {
        fileIsJustVarExports = false;
      }

      if (type === 'mixin') {
        return `${
          isUsedInFile ? '' : 'export '
        }${acc}\nfunction ${name} {\n  return css\`${contents}\n  \`;\n}\n`;
      }

      if (type === 'constVar') {
        return `${acc}\n${isUsedInFile ? '' : 'export '}const ${placeHolderToVar(node.prop)} = ${
          node.value.includes("'")
            ? `"${node.value.replace('\n', ' ')}"`
            : `'${node.value.replace('\n', ' ')}'`
        }`;
      }

      return `${acc}\n${
        type === 'class' || !isUsedInFile ? 'export ' : ''
      }const ${name} = css\`${contents}\n\`;\n`;
    }, '');

  const js = `${fileIsJustVarExports ? '' : "import { css } from '@emotion/core'"};\n${
    root.usesFeBraryVars ? "import { variables as vars } from '@domain-group/fe-brary';\n" : ''
  }${root.usesCustomVars ? "import customVars from '../variables';\n" : ''}${emotionExports}
`;

  return format({ text: js, filePath, prettierOptions: { parser: 'babylon' } });
};
