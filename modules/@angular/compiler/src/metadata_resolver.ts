/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AnimationAnimateMetadata, AnimationEntryMetadata, AnimationGroupMetadata, AnimationKeyframesSequenceMetadata, AnimationMetadata, AnimationStateDeclarationMetadata, AnimationStateMetadata, AnimationStateTransitionMetadata, AnimationStyleMetadata, AnimationWithStepsMetadata, Attribute, ChangeDetectionStrategy, Component, Directive, Host, Inject, Injectable, ModuleWithProviders, Optional, Provider, Query, SchemaMetadata, Self, SkipSelf, Type, resolveForwardRef} from '@angular/core';

import {isStaticSymbol} from './aot/static_symbol';
import {assertArrayOfStrings, assertInterpolationSymbols} from './assertions';
import * as cpl from './compile_metadata';
import {DirectiveNormalizer} from './directive_normalizer';
import {DirectiveResolver} from './directive_resolver';
import {ListWrapper, StringMapWrapper} from './facade/collection';
import {isBlank, isPresent, stringify} from './facade/lang';
import {Identifiers, createIdentifierToken, resolveIdentifier} from './identifiers';
import {hasLifecycleHook} from './lifecycle_reflector';
import {NgModuleResolver} from './ng_module_resolver';
import {PipeResolver} from './pipe_resolver';
import {ComponentStillLoadingError, LIFECYCLE_HOOKS_VALUES, ReflectorReader, reflector} from './private_import_core';
import {ElementSchemaRegistry} from './schema/element_schema_registry';
import {getUrlScheme} from './url_resolver';
import {MODULE_SUFFIX, SyncAsyncResult, ValueTransformer, visitValue} from './util';



// Design notes:
// - don't lazily create metadata:
//   For some metadata, we need to do async work sometimes,
//   so the user has to kick off this loading.
//   But we want to report errors even when the async work is
//   not required to check that the user would have been able
//   to wait correctly.
@Injectable()
export class CompileMetadataResolver {
  private _directiveCache = new Map<Type<any>, cpl.CompileDirectiveMetadata>();
  private _directiveSummaryCache = new Map<Type<any>, cpl.CompileDirectiveSummary>();
  private _pipeCache = new Map<Type<any>, cpl.CompilePipeMetadata>();
  private _pipeSummaryCache = new Map<Type<any>, cpl.CompilePipeSummary>();
  private _ngModuleCache = new Map<Type<any>, cpl.CompileNgModuleMetadata>();
  private _ngModuleOfTypes = new Map<Type<any>, Type<any>>();

  constructor(
      private _ngModuleResolver: NgModuleResolver, private _directiveResolver: DirectiveResolver,
      private _pipeResolver: PipeResolver, private _schemaRegistry: ElementSchemaRegistry,
      private _directiveNormalizer: DirectiveNormalizer,
      private _reflector: ReflectorReader = reflector) {}

  clearCacheFor(type: Type<any>) {
    const dirMeta = this._directiveCache.get(type);
    this._directiveCache.delete(type);
    this._directiveSummaryCache.delete(type);
    this._pipeCache.delete(type);
    this._pipeSummaryCache.delete(type);
    this._ngModuleOfTypes.delete(type);
    // Clear all of the NgModule as they contain transitive information!
    this._ngModuleCache.clear();
    if (dirMeta) {
      this._directiveNormalizer.clearCacheFor(dirMeta);
    }
  }

  clearCache() {
    this._directiveCache.clear();
    this._directiveSummaryCache.clear();
    this._pipeCache.clear();
    this._pipeSummaryCache.clear();
    this._ngModuleCache.clear();
    this._ngModuleOfTypes.clear();
    this._directiveNormalizer.clearCache();
  }

  getAnimationEntryMetadata(entry: AnimationEntryMetadata): cpl.CompileAnimationEntryMetadata {
    const defs = entry.definitions.map(def => this._getAnimationStateMetadata(def));
    return new cpl.CompileAnimationEntryMetadata(entry.name, defs);
  }

  private _getAnimationStateMetadata(value: AnimationStateMetadata):
      cpl.CompileAnimationStateMetadata {
    if (value instanceof AnimationStateDeclarationMetadata) {
      const styles = this._getAnimationStyleMetadata(value.styles);
      return new cpl.CompileAnimationStateDeclarationMetadata(value.stateNameExpr, styles);
    }

    if (value instanceof AnimationStateTransitionMetadata) {
      return new cpl.CompileAnimationStateTransitionMetadata(
          value.stateChangeExpr, this._getAnimationMetadata(value.steps));
    }

    return null;
  }

  private _getAnimationStyleMetadata(value: AnimationStyleMetadata):
      cpl.CompileAnimationStyleMetadata {
    return new cpl.CompileAnimationStyleMetadata(value.offset, value.styles);
  }

  private _getAnimationMetadata(value: AnimationMetadata): cpl.CompileAnimationMetadata {
    if (value instanceof AnimationStyleMetadata) {
      return this._getAnimationStyleMetadata(value);
    }

    if (value instanceof AnimationKeyframesSequenceMetadata) {
      return new cpl.CompileAnimationKeyframesSequenceMetadata(
          value.steps.map(entry => this._getAnimationStyleMetadata(entry)));
    }

    if (value instanceof AnimationAnimateMetadata) {
      const animateData =
          <cpl.CompileAnimationStyleMetadata|cpl.CompileAnimationKeyframesSequenceMetadata>this
              ._getAnimationMetadata(value.styles);
      return new cpl.CompileAnimationAnimateMetadata(value.timings, animateData);
    }

    if (value instanceof AnimationWithStepsMetadata) {
      const steps = value.steps.map(step => this._getAnimationMetadata(step));

      if (value instanceof AnimationGroupMetadata) {
        return new cpl.CompileAnimationGroupMetadata(steps);
      }

      return new cpl.CompileAnimationSequenceMetadata(steps);
    }
    return null;
  }

  private _loadDirectiveMetadata(directiveType: any, isSync: boolean): Promise<any> {
    if (this._directiveCache.has(directiveType)) {
      return;
    }
    directiveType = resolveForwardRef(directiveType);
    const {annotation, metadata} = this.getNonNormalizedDirectiveMetadata(directiveType);

    const createDirectiveMetadata = (templateMetadata: cpl.CompileTemplateMetadata) => {
      const normalizedDirMeta = new cpl.CompileDirectiveMetadata({
        type: metadata.type,
        isComponent: metadata.isComponent,
        selector: metadata.selector,
        exportAs: metadata.exportAs,
        changeDetection: metadata.changeDetection,
        inputs: metadata.inputs,
        outputs: metadata.outputs,
        hostListeners: metadata.hostListeners,
        hostProperties: metadata.hostProperties,
        hostAttributes: metadata.hostAttributes,
        providers: metadata.providers,
        viewProviders: metadata.viewProviders,
        queries: metadata.queries,
        viewQueries: metadata.viewQueries,
        entryComponents: metadata.entryComponents,
        template: templateMetadata
      });
      this._directiveCache.set(directiveType, normalizedDirMeta);
      this._directiveSummaryCache.set(directiveType, normalizedDirMeta.toSummary());
      return normalizedDirMeta;
    };

    if (metadata.isComponent) {
      const templateMeta = this._directiveNormalizer.normalizeTemplate({
        componentType: directiveType,
        moduleUrl: componentModuleUrl(this._reflector, directiveType, annotation),
        encapsulation: metadata.template.encapsulation,
        template: metadata.template.template,
        templateUrl: metadata.template.templateUrl,
        styles: metadata.template.styles,
        styleUrls: metadata.template.styleUrls,
        animations: metadata.template.animations,
        interpolation: metadata.template.interpolation
      });
      if (templateMeta.syncResult) {
        createDirectiveMetadata(templateMeta.syncResult);
        return null;
      } else {
        if (isSync) {
          throw new ComponentStillLoadingError(directiveType);
        }
        return templateMeta.asyncResult.then(createDirectiveMetadata);
      }
    } else {
      // directive
      createDirectiveMetadata(null);
      return null;
    }
  }

  getNonNormalizedDirectiveMetadata(directiveType: any):
      {annotation: Directive, metadata: cpl.CompileDirectiveMetadata} {
    directiveType = resolveForwardRef(directiveType);
    const dirMeta = this._directiveResolver.resolve(directiveType);
    if (!dirMeta) {
      return null;
    }
    let nonNormalizedTemplateMetadata: cpl.CompileTemplateMetadata;

    if (dirMeta instanceof Component) {
      // component
      assertArrayOfStrings('styles', dirMeta.styles);
      assertArrayOfStrings('styleUrls', dirMeta.styleUrls);
      assertInterpolationSymbols('interpolation', dirMeta.interpolation);

      const animations = dirMeta.animations ?
          dirMeta.animations.map(e => this.getAnimationEntryMetadata(e)) :
          null;

      nonNormalizedTemplateMetadata = new cpl.CompileTemplateMetadata({
        encapsulation: dirMeta.encapsulation,
        template: dirMeta.template,
        templateUrl: dirMeta.templateUrl,
        styles: dirMeta.styles,
        styleUrls: dirMeta.styleUrls,
        animations: animations,
        interpolation: dirMeta.interpolation
      });
    }

    let changeDetectionStrategy: ChangeDetectionStrategy = null;
    let viewProviders: Array<cpl.CompileProviderMetadata|cpl.CompileTypeMetadata|any[]> = [];
    let entryComponentMetadata: cpl.CompileIdentifierMetadata[] = [];
    let selector = dirMeta.selector;

    if (dirMeta instanceof Component) {
      // Component
      changeDetectionStrategy = dirMeta.changeDetection;
      if (dirMeta.viewProviders) {
        viewProviders = this._getProvidersMetadata(
            dirMeta.viewProviders, entryComponentMetadata,
            `viewProviders for "${stringify(directiveType)}"`);
      }
      if (dirMeta.entryComponents) {
        entryComponentMetadata = flattenAndDedupeArray(dirMeta.entryComponents)
                                     .map((type) => this._getIdentifierMetadata(type))
                                     .concat(entryComponentMetadata);
      }
      if (!selector) {
        selector = this._schemaRegistry.getDefaultComponentElementName();
      }
    } else {
      // Directive
      if (!selector) {
        throw new Error(`Directive ${stringify(directiveType)} has no selector, please add it!`);
      }
    }

    let providers: Array<cpl.CompileProviderMetadata|cpl.CompileTypeMetadata|any[]> = [];
    if (isPresent(dirMeta.providers)) {
      providers = this._getProvidersMetadata(
          dirMeta.providers, entryComponentMetadata, `providers for "${stringify(directiveType)}"`);
    }
    let queries: cpl.CompileQueryMetadata[] = [];
    let viewQueries: cpl.CompileQueryMetadata[] = [];
    if (isPresent(dirMeta.queries)) {
      queries = this._getQueriesMetadata(dirMeta.queries, false, directiveType);
      viewQueries = this._getQueriesMetadata(dirMeta.queries, true, directiveType);
    }

    const metadata = cpl.CompileDirectiveMetadata.create({
      selector: selector,
      exportAs: dirMeta.exportAs,
      isComponent: !!nonNormalizedTemplateMetadata,
      type: this._getTypeMetadata(directiveType),
      template: nonNormalizedTemplateMetadata,
      changeDetection: changeDetectionStrategy,
      inputs: dirMeta.inputs,
      outputs: dirMeta.outputs,
      host: dirMeta.host,
      providers: providers,
      viewProviders: viewProviders,
      queries: queries,
      viewQueries: viewQueries,
      entryComponents: entryComponentMetadata
    });
    return {metadata, annotation: dirMeta};
  }

  /**
   * Gets the metadata for the given directive.
   * This assumes `loadNgModuleMetadata` has been called first.
   */
  getDirectiveMetadata(directiveType: any): cpl.CompileDirectiveMetadata {
    const dirMeta = this._directiveCache.get(directiveType);
    if (!dirMeta) {
      throw new Error(
          `Illegal state: getDirectiveMetadata can only be called after loadNgModuleMetadata for a module that declares it. Directive ${stringify(directiveType)}.`);
    }
    return dirMeta;
  }

  getDirectiveSummary(dirType: any): cpl.CompileDirectiveSummary {
    const dirSummary = this._directiveSummaryCache.get(dirType);
    if (!dirSummary) {
      throw new Error(
          `Illegal state: getDirectiveSummary can only be called after loadNgModuleMetadata for a module that imports it. Directive ${stringify(dirType)}.`);
    }
    return dirSummary;
  }

  isDirective(type: any) { return this._directiveResolver.isDirective(type); }

  isPipe(type: any) { return this._pipeResolver.isPipe(type); }

  /**
   * Gets the metadata for the given module.
   * This assumes `loadNgModuleMetadata` has been called first.
   */
  getNgModuleMetadata(moduleType: any): cpl.CompileNgModuleMetadata {
    const modMeta = this._ngModuleCache.get(moduleType);
    if (!modMeta) {
      throw new Error(
          `Illegal state: getNgModuleMetadata can only be called after loadNgModuleMetadata. Module ${stringify(moduleType)}.`);
    }
    return modMeta;
  }

  private _loadNgModuleSummary(moduleType: any, isSync: boolean): cpl.CompileNgModuleSummary {
    // TODO(tbosch): add logic to read summary files!
    // - needs to add directive / pipe summaries to this._directiveSummaryCache /
    // this._pipeSummaryCache as well!
    const moduleMeta = this._loadNgModuleMetadata(moduleType, isSync, false);
    return moduleMeta ? moduleMeta.toSummary() : null;
  }

  /**
   * Loads an NgModule and all of its directives. This includes loading the exported directives of
   * imported modules,
   * but not private directives of imported modules.
   */
  loadNgModuleMetadata(moduleType: any, isSync: boolean, throwIfNotFound = true):
      {ngModule: cpl.CompileNgModuleMetadata, loading: Promise<any>} {
    const ngModule = this._loadNgModuleMetadata(moduleType, isSync, throwIfNotFound);
    const loading = ngModule ?
        Promise.all(ngModule.transitiveModule.directiveLoaders.map(loader => loader())) :
        Promise.resolve(null);
    return {ngModule, loading};
  }

  /**
   * Get the NgModule metadata without loading the directives.
   */
  getUnloadedNgModuleMetadata(moduleType: any, isSync: boolean, throwIfNotFound = true):
      cpl.CompileNgModuleMetadata {
    return this._loadNgModuleMetadata(moduleType, isSync, throwIfNotFound);
  }

  private _loadNgModuleMetadata(moduleType: any, isSync: boolean, throwIfNotFound = true):
      cpl.CompileNgModuleMetadata {
    moduleType = resolveForwardRef(moduleType);
    let compileMeta = this._ngModuleCache.get(moduleType);
    if (compileMeta) {
      return compileMeta;
    }
    const meta = this._ngModuleResolver.resolve(moduleType, throwIfNotFound);
    if (!meta) {
      return null;
    }
    const declaredDirectives: cpl.CompileIdentifierMetadata[] = [];
    const exportedNonModuleIdentifiers: cpl.CompileIdentifierMetadata[] = [];
    const declaredPipes: cpl.CompileIdentifierMetadata[] = [];
    const importedModules: cpl.CompileNgModuleSummary[] = [];
    const exportedModules: cpl.CompileNgModuleSummary[] = [];
    const providers: any[] = [];
    const entryComponents: cpl.CompileIdentifierMetadata[] = [];
    const bootstrapComponents: cpl.CompileIdentifierMetadata[] = [];
    const schemas: SchemaMetadata[] = [];

    if (meta.imports) {
      flattenAndDedupeArray(meta.imports).forEach((importedType) => {
        let importedModuleType: Type<any>;
        if (isValidType(importedType)) {
          importedModuleType = importedType;
        } else if (importedType && importedType.ngModule) {
          const moduleWithProviders: ModuleWithProviders = importedType;
          importedModuleType = moduleWithProviders.ngModule;
          if (moduleWithProviders.providers) {
            providers.push(...this._getProvidersMetadata(
                moduleWithProviders.providers, entryComponents,
                `provider for the NgModule '${stringify(importedModuleType)}'`));
          }
        }

        if (importedModuleType) {
          const importedModuleSummary = this._loadNgModuleSummary(importedModuleType, isSync);
          if (!importedModuleSummary) {
            throw new Error(
                `Unexpected ${this._getTypeDescriptor(importedType)} '${stringify(importedType)}' imported by the module '${stringify(moduleType)}'`);
          }
          importedModules.push(importedModuleSummary);
        } else {
          throw new Error(
              `Unexpected value '${stringify(importedType)}' imported by the module '${stringify(moduleType)}'`);
        }
      });
    }

    if (meta.exports) {
      flattenAndDedupeArray(meta.exports).forEach((exportedType) => {
        if (!isValidType(exportedType)) {
          throw new Error(
              `Unexpected value '${stringify(exportedType)}' exported by the module '${stringify(moduleType)}'`);
        }
        const exportedModuleSummary = this._loadNgModuleSummary(exportedType, isSync);
        if (exportedModuleSummary) {
          exportedModules.push(exportedModuleSummary);
        } else {
          exportedNonModuleIdentifiers.push(this._getIdentifierMetadata(exportedType));
        }
      });
    }

    // Note: This will be modified later, so we rely on
    // getting a new instance every time!
    const transitiveModule = this._getTransitiveNgModuleMetadata(importedModules, exportedModules);
    if (meta.declarations) {
      flattenAndDedupeArray(meta.declarations).forEach((declaredType) => {
        if (!isValidType(declaredType)) {
          throw new Error(
              `Unexpected value '${stringify(declaredType)}' declared by the module '${stringify(moduleType)}'`);
        }
        const declaredIdentifier = this._getIdentifierMetadata(declaredType);
        if (this._directiveResolver.isDirective(declaredType)) {
          transitiveModule.directivesSet.add(declaredType);
          transitiveModule.directives.push(declaredIdentifier);
          declaredDirectives.push(declaredIdentifier);
          this._addTypeToModule(declaredType, moduleType);
          transitiveModule.directiveLoaders.push(
              () => this._loadDirectiveMetadata(declaredType, isSync));
        } else if (this._pipeResolver.isPipe(declaredType)) {
          transitiveModule.pipesSet.add(declaredType);
          transitiveModule.pipes.push(declaredIdentifier);
          declaredPipes.push(declaredIdentifier);
          this._addTypeToModule(declaredType, moduleType);
          this._loadPipeMetadata(declaredType);
        } else {
          throw new Error(
              `Unexpected ${this._getTypeDescriptor(declaredType)} '${stringify(declaredType)}' declared by the module '${stringify(moduleType)}'`);
        }
      });
    }

    const exportedDirectives: cpl.CompileIdentifierMetadata[] = [];
    const exportedPipes: cpl.CompileIdentifierMetadata[] = [];
    exportedNonModuleIdentifiers.forEach((exportedId) => {
      if (transitiveModule.directivesSet.has(exportedId.reference)) {
        exportedDirectives.push(exportedId);
      } else if (transitiveModule.pipesSet.has(exportedId.reference)) {
        exportedPipes.push(exportedId);
      } else {
        throw new Error(
            `Can't export ${this._getTypeDescriptor(exportedId.reference)} ${stringify(exportedId.reference)} from ${stringify(moduleType)} as it was neither declared nor imported!`);
      }
    });

    // The providers of the module have to go last
    // so that they overwrite any other provider we already added.
    if (meta.providers) {
      providers.push(...this._getProvidersMetadata(
          meta.providers, entryComponents, `provider for the NgModule '${stringify(moduleType)}'`));
    }

    if (meta.entryComponents) {
      entryComponents.push(
          ...flattenAndDedupeArray(meta.entryComponents).map(type => this._getTypeMetadata(type)));
    }

    if (meta.bootstrap) {
      const typeMetadata = flattenAndDedupeArray(meta.bootstrap).map(type => {
        if (!isValidType(type)) {
          throw new Error(
              `Unexpected value '${stringify(type)}' used in the bootstrap property of module '${stringify(moduleType)}'`);
        }
        return this._getTypeMetadata(type);
      });
      bootstrapComponents.push(...typeMetadata);
    }

    entryComponents.push(...bootstrapComponents);

    if (meta.schemas) {
      schemas.push(...flattenAndDedupeArray(meta.schemas));
    }

    transitiveModule.entryComponents.push(...entryComponents);
    transitiveModule.providers.push(...providers);

    compileMeta = new cpl.CompileNgModuleMetadata({
      type: this._getTypeMetadata(moduleType),
      providers,
      entryComponents,
      bootstrapComponents,
      schemas,
      declaredDirectives,
      exportedDirectives,
      declaredPipes,
      exportedPipes,
      importedModules,
      exportedModules,
      transitiveModule,
      id: meta.id,
    });

    transitiveModule.modules.push(compileMeta.toInjectorSummary());
    this._ngModuleCache.set(moduleType, compileMeta);
    return compileMeta;
  }

  private _getTypeDescriptor(type: Type<any>): string {
    if (this._directiveResolver.isDirective(type)) {
      return 'directive';
    }

    if (this._pipeResolver.isPipe(type)) {
      return 'pipe';
    }

    if (this._ngModuleResolver.isNgModule(type)) {
      return 'module';
    }

    if ((type as any).provide) {
      return 'provider';
    }

    return 'value';
  }


  private _addTypeToModule(type: Type<any>, moduleType: Type<any>) {
    const oldModule = this._ngModuleOfTypes.get(type);
    if (oldModule && oldModule !== moduleType) {
      throw new Error(
          `Type ${stringify(type)} is part of the declarations of 2 modules: ${stringify(oldModule)} and ${stringify(moduleType)}! ` +
          `Please consider moving ${stringify(type)} to a higher module that imports ${stringify(oldModule)} and ${stringify(moduleType)}. ` +
          `You can also create a new NgModule that exports and includes ${stringify(type)} then import that NgModule in ${stringify(oldModule)} and ${stringify(moduleType)}.`);
    }
    this._ngModuleOfTypes.set(type, moduleType);
  }

  private _getTransitiveNgModuleMetadata(
      importedModules: cpl.CompileNgModuleSummary[],
      exportedModules: cpl.CompileNgModuleSummary[]): cpl.TransitiveCompileNgModuleMetadata {
    // collect `providers` / `entryComponents` from all imported and all exported modules
    const transitiveModules = getTransitiveImportedModules(importedModules.concat(exportedModules));
    const providers = flattenArray(transitiveModules.map((ngModule) => ngModule.providers));
    const entryComponents =
        flattenArray(transitiveModules.map((ngModule) => ngModule.entryComponents));

    const transitiveExportedModules = getTransitiveExportedModules(importedModules);
    const directives =
        flattenArray(transitiveExportedModules.map((ngModule) => ngModule.exportedDirectives));
    const pipes = flattenArray(transitiveExportedModules.map((ngModule) => ngModule.exportedPipes));
    const directiveLoaders =
        ListWrapper.flatten(transitiveExportedModules.map(ngModule => ngModule.directiveLoaders));
    return new cpl.TransitiveCompileNgModuleMetadata(
        transitiveModules, providers, entryComponents, directives, pipes, directiveLoaders);
  }

  private _getIdentifierMetadata(type: Type<any>): cpl.CompileIdentifierMetadata {
    type = resolveForwardRef(type);
    return new cpl.CompileIdentifierMetadata({reference: type});
  }

  private _getTypeMetadata(type: Type<any>, dependencies: any[] = null): cpl.CompileTypeMetadata {
    const identifier = this._getIdentifierMetadata(type);
    return new cpl.CompileTypeMetadata({
      reference: identifier.reference,
      diDeps: this._getDependenciesMetadata(identifier.reference, dependencies),
      lifecycleHooks:
          LIFECYCLE_HOOKS_VALUES.filter(hook => hasLifecycleHook(hook, identifier.reference)),
    });
  }

  private _getFactoryMetadata(factory: Function, dependencies: any[] = null):
      cpl.CompileFactoryMetadata {
    factory = resolveForwardRef(factory);
    return new cpl.CompileFactoryMetadata(
        {reference: factory, diDeps: this._getDependenciesMetadata(factory, dependencies)});
  }

  /**
   * Gets the metadata for the given pipe.
   * This assumes `loadNgModuleMetadata` has been called first.
   */
  getPipeMetadata(pipeType: any): cpl.CompilePipeMetadata {
    const pipeMeta = this._pipeCache.get(pipeType);
    if (!pipeMeta) {
      throw new Error(
          `Illegal state: getPipeMetadata can only be called after loadNgModuleMetadata for a module that declares it. Pipe ${stringify(pipeType)}.`);
    }
    return pipeMeta;
  }

  getPipeSummary(pipeType: any): cpl.CompilePipeSummary {
    const pipeSummary = this._pipeSummaryCache.get(pipeType);
    if (!pipeSummary) {
      throw new Error(
          `Illegal state: getPipeSummary can only be called after loadNgModuleMetadata for a module that imports it. Pipe ${stringify(pipeType)}.`);
    }
    return pipeSummary;
  }

  getOrLoadPipeMetadata(pipeType: any): cpl.CompilePipeMetadata {
    let pipeMeta = this._pipeCache.get(pipeType);
    if (!pipeMeta) {
      pipeMeta = this._loadPipeMetadata(pipeType);
    }
    return pipeMeta;
  }

  private _loadPipeMetadata(pipeType: any): cpl.CompilePipeMetadata {
    pipeType = resolveForwardRef(pipeType);
    const pipeAnnotation = this._pipeResolver.resolve(pipeType);

    const pipeMeta = new cpl.CompilePipeMetadata({
      type: this._getTypeMetadata(pipeType),
      name: pipeAnnotation.name,
      pure: pipeAnnotation.pure
    });
    this._pipeCache.set(pipeType, pipeMeta);
    this._pipeSummaryCache.set(pipeType, pipeMeta.toSummary());
    return pipeMeta;
  }

  private _getDependenciesMetadata(typeOrFunc: Type<any>|Function, dependencies: any[]):
      cpl.CompileDiDependencyMetadata[] {
    let hasUnknownDeps = false;
    const params = dependencies || this._reflector.parameters(typeOrFunc) || [];

    const dependenciesMetadata: cpl.CompileDiDependencyMetadata[] = params.map((param) => {
      let isAttribute = false;
      let isHost = false;
      let isSelf = false;
      let isSkipSelf = false;
      let isOptional = false;
      let token: any = null;
      if (Array.isArray(param)) {
        param.forEach((paramEntry) => {
          if (paramEntry instanceof Host) {
            isHost = true;
          } else if (paramEntry instanceof Self) {
            isSelf = true;
          } else if (paramEntry instanceof SkipSelf) {
            isSkipSelf = true;
          } else if (paramEntry instanceof Optional) {
            isOptional = true;
          } else if (paramEntry instanceof Attribute) {
            isAttribute = true;
            token = paramEntry.attributeName;
          } else if (paramEntry instanceof Inject) {
            token = paramEntry.token;
          } else if (isValidType(paramEntry) && isBlank(token)) {
            token = paramEntry;
          }
        });
      } else {
        token = param;
      }
      if (isBlank(token)) {
        hasUnknownDeps = true;
        return null;
      }

      return new cpl.CompileDiDependencyMetadata({
        isAttribute,
        isHost,
        isSelf,
        isSkipSelf,
        isOptional,
        token: this._getTokenMetadata(token)
      });

    });

    if (hasUnknownDeps) {
      const depsTokens =
          dependenciesMetadata.map((dep) => dep ? stringify(dep.token) : '?').join(', ');
      throw new Error(
          `Can't resolve all parameters for ${stringify(typeOrFunc)}: (${depsTokens}).`);
    }

    return dependenciesMetadata;
  }

  private _getTokenMetadata(token: any): cpl.CompileTokenMetadata {
    token = resolveForwardRef(token);
    let compileToken: cpl.CompileTokenMetadata;
    if (typeof token === 'string') {
      compileToken = new cpl.CompileTokenMetadata({value: token});
    } else {
      compileToken = new cpl.CompileTokenMetadata(
          {identifier: new cpl.CompileIdentifierMetadata({reference: token})});
    }
    return compileToken;
  }

  private _getProvidersMetadata(
      providers: Provider[], targetEntryComponents: cpl.CompileIdentifierMetadata[],
      debugInfo?: string): Array<cpl.CompileProviderMetadata|cpl.CompileTypeMetadata|any[]> {
    const compileProviders: Array<cpl.CompileProviderMetadata|cpl.CompileTypeMetadata|any[]> = [];
    providers.forEach((provider: any, providerIdx: number) => {
      provider = resolveForwardRef(provider);
      if (provider && typeof provider == 'object' && provider.hasOwnProperty('provide')) {
        provider = new cpl.ProviderMeta(provider.provide, provider);
      }
      let compileProvider: cpl.CompileProviderMetadata|cpl.CompileTypeMetadata|any[];
      if (Array.isArray(provider)) {
        compileProvider = this._getProvidersMetadata(provider, targetEntryComponents, debugInfo);
      } else if (provider instanceof cpl.ProviderMeta) {
        const tokenMeta = this._getTokenMetadata(provider.token);
        if (cpl.tokenReference(tokenMeta) ===
            resolveIdentifier(Identifiers.ANALYZE_FOR_ENTRY_COMPONENTS)) {
          targetEntryComponents.push(...this._getEntryComponentsFromProvider(provider));
        } else {
          compileProvider = this.getProviderMetadata(provider);
        }
      } else if (isValidType(provider)) {
        compileProvider = this._getTypeMetadata(provider);
      } else {
        const providersInfo =
            (<string[]>providers.reduce(
                 (soFar: string[], seenProvider: any, seenProviderIdx: number) => {
                   if (seenProviderIdx < providerIdx) {
                     soFar.push(`${stringify(seenProvider)}`);
                   } else if (seenProviderIdx == providerIdx) {
                     soFar.push(`?${stringify(seenProvider)}?`);
                   } else if (seenProviderIdx == providerIdx + 1) {
                     soFar.push('...');
                   }
                   return soFar;
                 },
                 []))
                .join(', ');

        throw new Error(
            `Invalid ${debugInfo ? debugInfo : 'provider'} - only instances of Provider and Type are allowed, got: [${providersInfo}]`);
      }
      if (compileProvider) {
        compileProviders.push(compileProvider);
      }
    });
    return compileProviders;
  }

  private _getEntryComponentsFromProvider(provider: cpl.ProviderMeta):
      cpl.CompileIdentifierMetadata[] {
    const components: cpl.CompileIdentifierMetadata[] = [];
    const collectedIdentifiers: cpl.CompileIdentifierMetadata[] = [];

    if (provider.useFactory || provider.useExisting || provider.useClass) {
      throw new Error(`The ANALYZE_FOR_ENTRY_COMPONENTS token only supports useValue!`);
    }

    if (!provider.multi) {
      throw new Error(`The ANALYZE_FOR_ENTRY_COMPONENTS token only supports 'multi = true'!`);
    }

    convertToCompileValue(provider.useValue, collectedIdentifiers);
    collectedIdentifiers.forEach((identifier) => {
      if (this._directiveResolver.isDirective(identifier.reference)) {
        components.push(identifier);
      }
    });
    return components;
  }

  getProviderMetadata(provider: cpl.ProviderMeta): cpl.CompileProviderMetadata {
    let compileDeps: cpl.CompileDiDependencyMetadata[];
    let compileTypeMetadata: cpl.CompileTypeMetadata = null;
    let compileFactoryMetadata: cpl.CompileFactoryMetadata = null;

    if (provider.useClass) {
      compileTypeMetadata = this._getTypeMetadata(provider.useClass, provider.dependencies);
      compileDeps = compileTypeMetadata.diDeps;
    } else if (provider.useFactory) {
      compileFactoryMetadata = this._getFactoryMetadata(provider.useFactory, provider.dependencies);
      compileDeps = compileFactoryMetadata.diDeps;
    }

    return new cpl.CompileProviderMetadata({
      token: this._getTokenMetadata(provider.token),
      useClass: compileTypeMetadata,
      useValue: convertToCompileValue(provider.useValue, []),
      useFactory: compileFactoryMetadata,
      useExisting: provider.useExisting ? this._getTokenMetadata(provider.useExisting) : null,
      deps: compileDeps,
      multi: provider.multi
    });
  }

  private _getQueriesMetadata(
      queries: {[key: string]: Query}, isViewQuery: boolean,
      directiveType: Type<any>): cpl.CompileQueryMetadata[] {
    const res: cpl.CompileQueryMetadata[] = [];

    Object.keys(queries).forEach((propertyName: string) => {
      const query = queries[propertyName];
      if (query.isViewQuery === isViewQuery) {
        res.push(this._getQueryMetadata(query, propertyName, directiveType));
      }
    });

    return res;
  }

  private _queryVarBindings(selector: any): string[] { return selector.split(/\s*,\s*/); }

  private _getQueryMetadata(q: Query, propertyName: string, typeOrFunc: Type<any>|Function):
      cpl.CompileQueryMetadata {
    let selectors: cpl.CompileTokenMetadata[];
    if (typeof q.selector === 'string') {
      selectors =
          this._queryVarBindings(q.selector).map(varName => this._getTokenMetadata(varName));
    } else {
      if (!q.selector) {
        throw new Error(
            `Can't construct a query for the property "${propertyName}" of "${stringify(typeOrFunc)}" since the query selector wasn't defined.`);
      }
      selectors = [this._getTokenMetadata(q.selector)];
    }

    return new cpl.CompileQueryMetadata({
      selectors,
      first: q.first,
      descendants: q.descendants, propertyName,
      read: q.read ? this._getTokenMetadata(q.read) : null
    });
  }
}

function getTransitiveExportedModules(
    modules: cpl.CompileNgModuleDirectiveSummary[],
    targetModules: cpl.CompileNgModuleDirectiveSummary[] = [],
    visitedModules = new Set<Type<any>>()): cpl.CompileNgModuleDirectiveSummary[] {
  modules.forEach((ngModule) => {
    if (!visitedModules.has(ngModule.type.reference)) {
      visitedModules.add(ngModule.type.reference);
      getTransitiveExportedModules(ngModule.exportedModules, targetModules, visitedModules);
      // Add after recursing so imported/exported modules are before the module itself.
      // This is important for overwriting providers of imported modules!
      targetModules.push(ngModule);
    }
  });
  return targetModules;
}

function getTransitiveImportedModules(
    modules: cpl.CompileNgModuleInjectorSummary[],
    targetModules: cpl.CompileNgModuleInjectorSummary[] = [],
    visitedModules = new Set<Type<any>>()): cpl.CompileNgModuleInjectorSummary[] {
  modules.forEach((ngModule) => {
    if (!visitedModules.has(ngModule.type.reference)) {
      visitedModules.add(ngModule.type.reference);
      const nestedModules = ngModule.importedModules.concat(ngModule.exportedModules);
      getTransitiveImportedModules(nestedModules, targetModules, visitedModules);
      // Add after recursing so imported/exported modules are before the module itself.
      // This is important for overwriting providers of imported modules!
      targetModules.push(ngModule);
    }
  });
  return targetModules;
}

function flattenArray(tree: any[], out: Array<any> = []): Array<any> {
  if (tree) {
    for (let i = 0; i < tree.length; i++) {
      const item = resolveForwardRef(tree[i]);
      if (Array.isArray(item)) {
        flattenArray(item, out);
      } else {
        out.push(item);
      }
    }
  }
  return out;
}

function dedupeArray(array: any[]): Array<any> {
  if (array) {
    return Array.from(new Set(array));
  }
  return [];
}

function flattenAndDedupeArray(tree: any[]): Array<any> {
  return dedupeArray(flattenArray(tree));
}

function isValidType(value: any): boolean {
  return isStaticSymbol(value) || (value instanceof Type);
}

export function componentModuleUrl(
    reflector: ReflectorReader, type: Type<any>, cmpMetadata: Component): string {
  if (isStaticSymbol(type)) {
    return type.filePath;
  }

  const moduleId = cmpMetadata.moduleId;

  if (typeof moduleId === 'string') {
    const scheme = getUrlScheme(moduleId);
    return scheme ? moduleId : `package:${moduleId}${MODULE_SUFFIX}`;
  } else if (moduleId !== null && moduleId !== void 0) {
    throw new Error(
        `moduleId should be a string in "${stringify(type)}". See https://goo.gl/wIDDiL for more information.\n` +
        `If you're using Webpack you should inline the template and the styles, see https://goo.gl/X2J8zc.`);
  }

  return reflector.importUri(type);
}

function convertToCompileValue(
    value: any, targetIdentifiers: cpl.CompileIdentifierMetadata[]): any {
  return visitValue(value, new _CompileValueConverter(), targetIdentifiers);
}

class _CompileValueConverter extends ValueTransformer {
  visitOther(value: any, targetIdentifiers: cpl.CompileIdentifierMetadata[]): any {
    const identifier = new cpl.CompileIdentifierMetadata({reference: value});
    targetIdentifiers.push(identifier);
    return identifier;
  }
}
