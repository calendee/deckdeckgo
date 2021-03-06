import {Component, Element, Listen, Method, Prop, State, Event, EventEmitter} from '@stencil/core';

import {DeckdeckgoSlideDefinition} from 'deckdeckgo-types';

import {DeckdeckgoUtils} from '../../utils/deckdeckgo-utils';

interface DeltaX {
  slider: HTMLElement
  swipeLeft: boolean;
  deltaX: number;
}

@Component({
  tag: 'deckgo-deck',
  styleUrl: 'deckdeckgo-deck.scss',
  shadow: true
})
export class DeckdeckgoDeck {

  @Element() el: HTMLElement;

  @Prop() keyboard: boolean = true;

  @Prop() pager: boolean = true;
  @Prop() pagerPercentage: boolean = true;

  @Prop() embedded: boolean = false;

  @State()
  private rtl: boolean = false;

  private startX: number = null;
  private deckTranslateX: number = 0;
  private autoSwipeRatio: number = 10;

  private blockSlide: boolean = false;

  @State()
  private activeIndex: number = 0;

  @State()
  private length: number = 0;

  @Event() slidesDidLoad: EventEmitter;
  @Event() slideNextDidChange: EventEmitter<number>;
  @Event() slidePrevDidChange: EventEmitter<number>;
  @Event() slideToChange: EventEmitter<number>;
  @Event() slideDrag: EventEmitter<number>;
  @Event() slideWillChange: EventEmitter<number>;

  private fullscreen: boolean = false;
  private cursorHidden: boolean = false;
  private idleMouseTimer: number;

  async componentWillLoad() {
    await this.initRtl();
  }

  async componentDidLoad() {
    await this.initEmbeddedSlideWidth();

    this.initWindowResize();
    this.initKeyboardAssist();

    await this.lazyBackgroungImages();
  }

  private initRtl(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (document && document.documentElement) {
        const htmlDir: string = document.documentElement.getAttribute('dir');
        this.rtl = htmlDir && htmlDir === 'rtl';
      }

      resolve();
    });
  }

  private initWindowResize() {
    if (window) {
      window.addEventListener('resize', DeckdeckgoUtils.debounce(async () => {
        await this.initEmbeddedSlideWidth();
        await this.slideTo(this.activeIndex);
      }, 100));
    }
  }

  private initEmbeddedSlideWidth(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.embedded) {
        resolve();
        return;
      }

      const slider: HTMLElement = this.el.shadowRoot.querySelector('div.deckgo-deck');

      if (!slider || !slider.offsetParent) {
        resolve();
        return;
      }

      if (slider.offsetParent.clientWidth > 0) {
        slider.style.setProperty('--slide-width', '' + slider.offsetParent.clientWidth + 'px');
      }

      if (slider.offsetParent.clientHeight) {
        slider.style.setProperty('--slide-height', '' + slider.offsetParent.clientHeight + 'px');
      }

      resolve();
    });
  }

  private initKeyboardAssist() {
    if (this.keyboard) {
      document.addEventListener('keydown', async (e) => {
        if (e.defaultPrevented) {
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          await this.slideNextPrev(false, true);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          await this.slideNextPrev(true, true);
        }
      });
    }
  }

  /* BEGIN: Handle swipe */

  @Listen('mousedown', {passive: true})
  mousedown($event: MouseEvent) {
    this.start($event);
  }

  @Listen('touchstart', {passive: true})
  touchstart($event: TouchEvent) {
    this.start($event);
  }

  @Listen('mouseup', {passive: true})
  async mouseup($event: MouseEvent) {
    await this.stop($event);
  }

  @Listen('touchend', {passive: true})
  async touchend($event: TouchEvent) {
    await this.stop($event);
  }

  @Listen('mousemove', {passive: true})
  async mousemove($event: MouseEvent) {
    await this.move($event);
  }

  @Listen('touchmove', {passive: true})
  async touchmove($event: TouchEvent) {
    await this.move($event);
  }

  @Listen('dblclick', {passive: true})
  async dblclick() {
    this.startX = null;
  }

  @Listen('scrolling')
  scrolling($event: CustomEvent) {
    this.blockSlide = $event ? $event.detail : false;
  }

  private start(e: Event) {
    this.startX = DeckdeckgoUtils.unifyEvent(e).clientX;
  }

  private async move(e: Event) {
    await this.clearMouseCursorTimer(true);

    if (this.blockSlide) {
      return;
    }

    const deltaX: DeltaX = await this.getDeltaX(e);

    if (!deltaX) {
      return;
    }

    const transformX: number = deltaX.swipeLeft ? this.deckTranslateX - deltaX.deltaX : this.deckTranslateX + deltaX.deltaX;

    deltaX.slider.style.setProperty('--transformX', transformX + 'px');
    deltaX.slider.style.setProperty('--transformXDuration', '0ms');

    this.slideDrag.emit(transformX);
  }

  private async stop(e: Event) {
    if (this.blockSlide) {
      return;
    }

    const deltaX: DeltaX = await this.getDeltaX(e);

    await this.swipeSlide(deltaX);

    this.startX = null;
  }

  private swipeSlide(deltaX: DeltaX, emitEvent: boolean = true): Promise<void> {
    return new Promise<void>(async (resolve) => {
      if (!deltaX || !window) {
        resolve();
        return;
      }

      let couldSwipeLeft: boolean = deltaX.swipeLeft && this.activeIndex < this.length - 1;
      let couldSwipeRight: boolean = !deltaX.swipeLeft && this.activeIndex > 0;

      if (this.rtl) {
        couldSwipeLeft = deltaX.swipeLeft && this.activeIndex > 0;
        couldSwipeRight = !deltaX.swipeLeft && this.activeIndex < this.length - 1;
      }

      if (couldSwipeLeft || couldSwipeRight) {
        const sliderWidth: number = await this.getSliderWidth();

        if (deltaX.deltaX > (sliderWidth / this.autoSwipeRatio)) {
          this.deckTranslateX = deltaX.swipeLeft ? this.deckTranslateX - sliderWidth : this.deckTranslateX + sliderWidth;

          if (this.isNextChange(deltaX.swipeLeft)) {
            this.activeIndex++;

            if (emitEvent) {
              this.slideNextDidChange.emit(this.activeIndex);
            }
          } else {
            this.activeIndex--;

            if (emitEvent) {
              this.slidePrevDidChange.emit(this.activeIndex);
            }
          }
        }
      }

      await this.doSwipeSlide(deltaX.slider);

      // We want to lazy load the next slide images in the background
      await this.lazyLoadContent(this.activeIndex + 1);

      resolve();
    });
  }

  private getSliderWidth(): Promise<number> {
    return new Promise<number>((resolve) => {
      if (!this.embedded) {
        resolve(window.innerWidth);
        return;
      }

      const slider: HTMLElement = this.el.shadowRoot.querySelector('div.deckgo-deck');

      if (!slider || !slider.offsetParent || slider.offsetParent.clientWidth <= 0) {
        resolve(window.innerWidth);
        return;
      }

      resolve(slider.offsetParent.clientWidth);
    });
  }

  private isNextChange(swipeLeft: boolean): boolean {
    return (swipeLeft && !this.rtl) || (!swipeLeft && this.rtl);
  }

  private doSwipeSlide(slider: HTMLElement, speed?: number | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      slider.style.setProperty('--transformX', this.deckTranslateX + 'px');
      slider.style.setProperty('--transformXDuration', '' + (!isNaN(speed) ? speed : 300) + 'ms');

      this.slideWillChange.emit(this.deckTranslateX);

      this.startX = null;

      resolve();
    });
  }

  private getDeltaX(e): Promise<DeltaX> {
    return new Promise<DeltaX>((resolve) => {
      if (!this.startX) {
        resolve(null);
        return;
      }

      const slider: HTMLElement = this.el.shadowRoot.querySelector('div.deckgo-deck');

      if (!slider) {
        resolve(null);
        return;
      }

      const currentX: number = DeckdeckgoUtils.unifyEvent(e).clientX;

      if (this.startX === currentX) {
        resolve(null);
        return;
      }

      const swipeLeft: boolean = this.startX > currentX;

      resolve({
        slider: slider,
        swipeLeft: swipeLeft,
        deltaX: swipeLeft ? (this.startX - currentX) : (currentX - this.startX)
      })
    });
  }

  /* END: Handle swipe */

  /* BEGIN: Slide length and active index */

  @Listen('slideDidLoad')
  async slideDidLoad() {
    this.length++;

    await this.emitSlidesDidLoad();
  }

  private emitSlidesDidLoad(): Promise<void> {
    return new Promise<void>(async (resolve) => {
      const definedSlides: HTMLCollection = this.el.children;
      const loadedSlides: NodeListOf<HTMLElement> = this.el.querySelectorAll('.deckgo-slide-container');

      const definedSlidesLength: number = await this.countDefinedSlides(definedSlides);

      // Are all slides loaded?
      if (definedSlides && loadedSlides && loadedSlides.length === definedSlidesLength && definedSlidesLength === this.length) {
        const orderedSlidesTagNames: DeckdeckgoSlideDefinition[] = [];

        Array.from(loadedSlides).forEach((slide: HTMLElement) => {
          const notes: HTMLElement = slide.querySelector('[slot=\'notes\']');

          orderedSlidesTagNames.push({
            name: slide.tagName,
            notes: notes ? notes.innerHTML : null
          });
        });

        this.slidesDidLoad.emit(orderedSlidesTagNames);

        await this.lazyLoadFirstSlides();
      }

      resolve();
    });
  }

  private lazyLoadFirstSlides(): Promise<void> {
    return new Promise<void>(async (resolve) => {
      const lazyLoadContentFirstSlide = this.lazyLoadContent(0);
      const lazyLoadContentSecondSlide = this.lazyLoadContent(1);

      await Promise.all([lazyLoadContentFirstSlide, lazyLoadContentSecondSlide]);

      resolve();
    });
  }

  // The last child might be a background and note a slides
  private countDefinedSlides(definedSlides: HTMLCollection): Promise<number> {
    return new Promise<number>((resolve) => {
      if (!definedSlides || definedSlides.length <= 0) {
        resolve(0);
        return;
      }

      const slides: Element[] = Array.from(definedSlides).filter((slide: Element) => {
        return slide.tagName.toLocaleLowerCase().indexOf('deckgo-slide-') > -1
      });

      resolve(slides ? slides.length : 0);
    });
  }

  @Method()
  isBeginning(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      resolve(this.activeIndex === 0);
    });
  }

  @Method()
  isEnd(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      resolve(this.activeIndex === this.length - 1);
    });
  }

  @Method()
  getActiveIndex(): Promise<number> {
    return new Promise<number>((resolve) => {
      resolve(this.activeIndex);
    });
  }

  @Method()
  getLength(): Promise<number> {
    return new Promise<number>((resolve) => {
      resolve(this.length);
    });
  }

  /* END: Slide length and active index */

  /* BEGIN: Manual sliding */

  @Method()
  async slideNext(slideAnimation?: boolean, emitEvent?: boolean) {
    await this.slideNextPrev(!this.rtl, slideAnimation, emitEvent);
  }

  @Method()
  async slidePrev(slideAnimation?: boolean, emitEvent?: boolean) {
    await this.slideNextPrev(this.rtl, slideAnimation, emitEvent);
  }

  private async slideNextPrev(swipeLeft: boolean, slideAnimation: boolean = true, emitEvent?: boolean) {
    const slider: HTMLElement = this.el.shadowRoot.querySelector('div.deckgo-deck');

    if (!slider || !window) {
      return;
    }

    let couldSwipe: boolean;

    if (!slideAnimation) {
      couldSwipe = true;
    } else {
      couldSwipe = await this.beforeSwipe(this.isNextChange(swipeLeft));
    }

    // We might want first to show hide stuffs in the slide before swiping
    if (couldSwipe) {
      const deltaX: DeltaX = {
        slider: slider,
        swipeLeft: swipeLeft,
        deltaX: window.innerWidth
      };

      await this.swipeSlide(deltaX, emitEvent);

      await this.afterSwipe(swipeLeft);
    }
  }

  private beforeSwipe(enter: boolean): Promise<boolean> {
    return new Promise<boolean>(async (resolve) => {
      const slide: HTMLElement = this.el.querySelector('.deckgo-slide-container:nth-child(' + (this.activeIndex + 1) + ')');

      if (!slide) {
        // If we find no slide, we are cool something went wrong but the talk/show must go on
        resolve(true);
      } else {
        const result: boolean = await (slide as any).beforeSwipe(enter);
        resolve(result);
      }
    });
  }

  private afterSwipe(swipeLeft: boolean): Promise<void> {
    return new Promise<void>(async (resolve) => {
      const indexPreviousSlide: number = swipeLeft ? this.activeIndex - 1 : this.activeIndex + 1;

      if (isNaN(indexPreviousSlide) || indexPreviousSlide < 0 || indexPreviousSlide > this.length) {
        resolve();
        return;
      }

      const slide: HTMLElement = this.el.querySelector('.deckgo-slide-container:nth-child(' + (indexPreviousSlide + 1) + ')');

      if (!slide) {
        // Might be a swipe after the first or last slide
        resolve();
      } else {
        await (slide as any).afterSwipe();
        resolve();
      }
    });
  }

  private lazyLoadContent(index: number): Promise<void> {
    return new Promise<void>(async (resolve) => {
      const slide: HTMLElement = this.el.querySelector('.deckgo-slide-container:nth-child(' + (index + 1) + ')');

      if (slide) {
        await (slide as any).lazyLoadContent();
      }

      resolve();
    });
  }

  // Lazy load images from slot=background
  private lazyBackgroungImages(): Promise<void> {
    return new Promise<void>(async (resolve) => {
      const allSlotedImages: NodeListOf<HTMLElement> = this.el.querySelectorAll('img[slot=\'background\']');
      const allShadowImages: NodeListOf<HTMLElement> = this.el.querySelectorAll('[slot=\'background\'] img');

      const images: HTMLElement[] = Array.from(allSlotedImages).concat(Array.from(allShadowImages));

      await DeckdeckgoUtils.lazyLoadSelectedImages(images);

      resolve();
    });
  }

  @Method()
  async slideTo(index: number, speed?: number | undefined, emitEvent: boolean = true) {
    if (index > this.length || index < 0) {
      return;
    }

    const slider: HTMLElement = this.el.shadowRoot.querySelector('div.deckgo-deck');

    if (!slider || !window) {
      return;
    }

    this.deckTranslateX = index * window.innerWidth * (this.rtl ? 1 : -1);
    this.activeIndex = index;

    await this.lazyLoadContent(this.activeIndex);
    await this.doSwipeSlide(slider, speed);

    if (emitEvent) {
      this.slideToChange.emit(index);
    }
  }

  /* END: Manual sliding */

  /* BEGIN: Full screen */

  @Method()
  toggleFullScreen(): Promise<void> {
    return new Promise<void>(async (resolve) => {
      const doc = window.document;
      const docEl = doc.documentElement;

      // @ts-ignore
      const requestFullScreen = docEl.requestFullscreen || docEl.mozRequestFullScreen || docEl.webkitRequestFullScreen || docEl.msRequestFullscreen;
      // @ts-ignore
      const cancelFullScreen = doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;

      // @ts-ignore
      if (!doc.fullscreenElement && !doc.mozFullScreenElement && !doc.webkitFullscreenElement && !doc.msFullscreenElement) {
        requestFullScreen.call(docEl);

        this.fullscreen = true;
        this.hideMouseCursorWithDelay();
      } else {
        cancelFullScreen.call(doc);

        await this.clearMouseCursorTimer(false);
        this.fullscreen = false;
      }

      resolve();
    });
  }

  private async clearMouseCursorTimer(hideWithDelay: boolean) {
    if (!this.fullscreen) {
      return;
    }

    if (this.idleMouseTimer > 0) {
      clearTimeout(this.idleMouseTimer);
    }

    await this.showHideMouseCursor(true);

    if (hideWithDelay) {
      this.hideMouseCursorWithDelay();
    }
  }

  private hideMouseCursorWithDelay() {
    if (!this.fullscreen) {
      return;
    }

    this.idleMouseTimer = setTimeout(async () => {
      await this.showHideMouseCursor(false);
    }, 4000);
  }

  private showHideMouseCursor(show: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.fullscreen) {
        resolve();
        return;
      }

      if (!this.cursorHidden && show) {
        // Cursor already displayed, we don't want to touch the style multiple times if not needed
        resolve();
        return;
      }

      const slider: HTMLElement = this.el.shadowRoot.querySelector('div.deckgo-deck');

      if (!slider) {
        resolve();
        return;
      }

      slider.style.setProperty('cursor', show ? 'initial' : 'none');

      this.cursorHidden = !show;

      resolve();
    });
  }

  /* END: Full screen */

  /* BEGIN: Utils */

  @Method()
  doPrint(): Promise<void> {
    return new Promise<void>(async (resolve) => {
      if (window) {
        await this.lazyLoadAllContent();

        window.print();
      }

      resolve();
    });
  }

  private lazyLoadAllContent(): Promise<void[]> {
    const promises = [];

    for (let i = 0; i < this.length; i++) {
      promises.push(this.lazyLoadContent(i));
    }

    return Promise.all(promises);
  }

  @Method()
  isMobile(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      resolve(DeckdeckgoUtils.isMobile());
    });
  }

  /* END: Utils */

  render() {
    return [
      <div class="deckgo-deck">
        <slot/>
        <slot name="background"></slot>
      </div>,
      <div class="deckgo-pager">{this.pager ? <deckgo-pager active-index={this.activeIndex} length={this.length}
                                                            percentage={this.pagerPercentage}></deckgo-pager> : ''}</div>
    ]
  }

}
