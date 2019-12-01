import fs from "fs";
import fse from "fs-extra";
import path from "path";
import mkDir from "make-dir";
import recursiveReadDir from "recursive-readdir";
import slash from "slash";
import * as babel from "@babel/core";
import chalk from "chalk";

const CONFIG_KEY = "_moduleMappings";

interface MappingConfigType {
    [key: string]: string;
}

const DefaultBabelOption = {
    compact: false,
    retainLines: true,
    minified: false,
    inputSourceMap: undefined,
    sourceMaps: false,
    code: true
};

function isTsDefinitionFile(filePath: string) {
    const ext = filePath
        .split(".")
        .slice(1)
        .join(".");
    return ext === "d.ts";
}

function getBabelOption(
    filePath: string,
    mappingConfig: MappingConfigType,
    isTsDefinitionFile: boolean
) {
    if (!isTsDefinitionFile) {
        return {
            ...DefaultBabelOption,
            plugins: [
                [
                    "module-resolver",
                    {
                        root: [path.dirname(filePath)],
                        alias: { ...mappingConfig }
                    }
                ]
            ]
        };
    } else {
        return {
            ...DefaultBabelOption,
            plugins: [
                "@babel/plugin-syntax-typescript",
                [
                    "module-resolver",
                    {
                        root: [path.dirname(filePath)],
                        alias: { ...mappingConfig }
                    }
                ]
            ]
        };
    }
}

function getAliasConfig() {
    const pkgJsonPath = path.resolve("./package.json");
    if (!fs.existsSync(pkgJsonPath)) {
        throw new Error("Can't locate package.json.");
    }
    const pkgJson = fse.readJSONSync(pkgJsonPath);
    if (!pkgJson[CONFIG_KEY]) {
        throw new Error(
            `Can't locate \`${CONFIG_KEY}\` property from package.json.`
        );
    }
    if (typeof pkgJson[CONFIG_KEY] !== "object") {
        throw new Error(
            `The \`${CONFIG_KEY}\` property of package.json must be a object.`
        );
    }
    if (!Object.keys(pkgJson[CONFIG_KEY]).length) {
        throw new Error(
            `The \`${CONFIG_KEY}\` property of package.json can't be an empty object.`
        );
    }
    return pkgJson[CONFIG_KEY];
}

async function transform(src: string, dst?: string) {
    const srcPath = slash(path.resolve(src));
    if (!fs.existsSync(srcPath)) {
        throw new Error(`Src path: \`${src}\` doesn't exist.`);
    }

    const dstPath: string = dst ? slash(path.resolve(dst)) : srcPath;
    if (!fs.existsSync(dstPath)) {
        await mkDir(dstPath);
    }
    const srcStat = fs.statSync(srcPath);
    const dstStat = fs.statSync(dstPath);
    const isSrcDirectory = srcStat.isDirectory();
    const isDstDirectory = dstStat.isDirectory();

    let srcList: string[];
    if (isSrcDirectory) {
        if (!isDstDirectory) {
            throw new Error(
                `Destination path: \`${dst}\` must be a directory when src is a directory.`
            );
        }

        srcList = await recursiveReadDir(srcPath, [
            (file, stats) => {
                if (!stats.isDirectory()) {
                    const ext = file
                        .split(".")
                        .slice(1)
                        .join(".");
                    if (ext === "js" || ext === "d.ts") return false;
                    else return true;
                }

                return false;
            }
        ]);
    } else {
        srcList = [srcPath];
    }

    const mappingConfig = getAliasConfig();
    let processCount = 0;

    for (let i = 0; i < srcList.length; i++) {
        const result = await transformFile(
            slash(srcList[i]),
            srcPath,
            isSrcDirectory,
            dstPath,
            isDstDirectory,
            mappingConfig
        );
        if (result) {
            processCount++;
        }
    }

    console.log(`Successfully compiled ${processCount} files with Babel.`);
}

const directiveRegEx = /^\/\/\/\s*<reference\s+types="([^"]+)"\s*\/>/gim;

function processMappingConfig(
    modulePath: string,
    mappingConfig: MappingConfigType
) {
    const fromModuleList = Object.keys(mappingConfig);

    for (let i = 0; i < fromModuleList.length; i++) {
        const fromModule = fromModuleList[i];
        const toModule = mappingConfig[fromModule];
        if (modulePath === fromModule) {
            return toModule;
        }
        if (modulePath.indexOf(fromModule) === 0) {
            return toModule + modulePath.substr(fromModule.length);
        }
    }

    return modulePath;
}

function processTypeDirective(code: string, mappingConfig: MappingConfigType) {
    return code.replace(
        directiveRegEx,
        (match, typePath: string) =>
            `/// <reference types="${processMappingConfig(
                typePath,
                mappingConfig
            )}" />`
    );
}

function getDstFilePath(
    filePath: string,
    srcPath: string,
    isSrcDirectory: boolean,
    dstPath: string,
    isDstDirectory: boolean
) {
    if (!isDstDirectory) {
        return dstPath;
    }
    if (!isSrcDirectory) {
        return path.join(dstPath, path.basename(filePath));
    }
    return path.join(dstPath, path.relative(srcPath, filePath));
}

async function transformFile(
    filePath: string,
    srcPath: string,
    isSrcDirectory: boolean,
    dstPath: string,
    isDstDirectory: boolean,
    mappingConfig: MappingConfigType
) {
    const isTsFile = isTsDefinitionFile(filePath);
    const babelOptions = getBabelOption(filePath, mappingConfig, isTsFile);
    const nodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";
    const result = await babel.transformFileAsync(filePath, babelOptions);
    process.env.NODE_ENV = nodeEnv;

    if (!result?.code) {
        console.log(chalk.yellow(`Input ${filePath} has no output.`));
        return false;
    }
    const code = isTsFile
        ? processTypeDirective(result.code, mappingConfig)
        : result.code;
    const dstFilePath = getDstFilePath(
        filePath,
        srcPath,
        isSrcDirectory,
        dstPath,
        isDstDirectory
    );

    const dstFileDir = path.dirname(dstFilePath);
    if (!fs.existsSync(dstFileDir)) {
        await mkDir(dstFileDir);
    }

    await fse.writeFile(dstFilePath, code);
    return true;
}

export default transform;
