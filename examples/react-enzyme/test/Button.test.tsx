import React from 'react';
import { shallow } from 'enzyme';
import { describe, expect, test, beforeEach, vi } from 'vitest';

import Button from '../components/Button';

describe('Button component', () => {
  let wrapper;
  const mockedOnSubmit = vi.fn();

  beforeEach(() => {
    wrapper = shallow(<Button onClick={mockedOnSubmit} text={'some-text'} />);
  });

  test('should render with correct props', () => {
    expect(wrapper).toBeDefined();
    expect(wrapper.name()).toBe('button');

    expect(wrapper.prop('className')).toBe('some-className');
    expect(typeof wrapper.prop('onClick')).toBe('function');

    expect(wrapper.text()).toBe('some-text');
  });

  test('should invoke onClick prop by clicking on the button', () => {
    wrapper.simulate('click');
    expect(mockedOnSubmit).toHaveBeenCalled();
  });
});
